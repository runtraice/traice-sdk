import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_NOTES = 6;
const MAX_NOTE_LENGTH = 700;

export function releaseNotesForVersion(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const heading = `## ${version}`;
  const start = lines.findIndex((line) => line.trim() === heading);

  if (start === -1) {
    throw new Error(`Could not find ${heading} in the package changelog.`);
  }

  const nextVersion = lines.findIndex((line, index) => index > start && /^##\s+\S/.test(line.trim()));
  const end = nextVersion === -1 ? lines.length : nextVersion;
  const notes = [];

  for (let index = start + 1; index < end; index += 1) {
    const bullet = lines[index].match(/^- (.+)$/);
    if (!bullet) continue;

    const parts = [bullet[1]];
    while (index + 1 < end && !/^- /.test(lines[index + 1]) && !/^##/.test(lines[index + 1].trim())) {
      index += 1;
      const continuation = lines[index].trim();
      if (continuation && !continuation.startsWith("- ")) parts.push(continuation);
    }

    const note = parts
      .join(" ")
      .replace(/^[0-9a-f]{7,40}:\s*/i, "")
      .replace(/\s+/g, " ")
      .trim();

    if (note && !note.startsWith("Updated dependencies")) notes.push(note);
  }

  return notes;
}

export function releaseSectionForSlack(packageName, version, notes) {
  const visibleNotes = notes.slice(0, MAX_NOTES);
  const lines = [`*${escapeSlack(packageName)}@${escapeSlack(version)}*`];

  for (const note of visibleNotes) {
    lines.push(`• ${escapeSlack(truncate(note, MAX_NOTE_LENGTH))}`);
  }

  if (notes.length > visibleNotes.length) {
    lines.push(`• +${notes.length - visibleNotes.length} more in the package changelog`);
  } else if (visibleNotes.length === 0) {
    lines.push("• See the package changelog for details.");
  }

  return lines.join("\n");
}

function escapeSlack(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function truncate(value, limit) {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1).trimEnd()}…`;
}

const invokedAsScript = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (invokedAsScript) {
  const [changelogPath, version, packageName] = process.argv.slice(2);
  if (!changelogPath || !version || !packageName) {
    console.error("Usage: node scripts/release-notes.mjs <changelog> <version> <package-name>");
    process.exitCode = 2;
  } else {
    const changelog = readFileSync(changelogPath, "utf8");
    const notes = releaseNotesForVersion(changelog, version);
    console.log(releaseSectionForSlack(packageName, version, notes));
  }
}
