import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const docsDirectory = join(repositoryRoot, "apps/docs/content/docs");
const filenames = readdirSync(docsDirectory).filter((filename) => filename.endsWith(".md"));
const docs = new Map(
  filenames.map((filename) => {
    const slug = filename.replace(/\.md$/, "");
    return [slug, { filename, slug, content: readFileSync(join(docsDirectory, filename), "utf8") }];
  }),
);
const failures = [];

function fail(filename, message) {
  failures.push(`${filename}: ${message}`);
}

function headingId(value) {
  return value
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[✨*_~]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

function frontmatterValue(content, field) {
  return content.match(new RegExp(`^${field}:\\s*(.+)$`, "m"))?.[1]?.trim();
}

const orderKeys = new Map();

for (const doc of docs.values()) {
  const match = doc.content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    fail(doc.filename, "missing YAML frontmatter");
    continue;
  }

  for (const field of ["title", "excerpt", "section", "sectionOrder", "order"]) {
    if (!frontmatterValue(match[1], field)) fail(doc.filename, `missing ${field} frontmatter`);
  }

  const section = frontmatterValue(match[1], "section");
  const sectionOrder = frontmatterValue(match[1], "sectionOrder");
  const order = frontmatterValue(match[1], "order");
  if (!/^\d+$/.test(sectionOrder ?? "")) fail(doc.filename, "sectionOrder must be an integer");
  if (!/^\d+$/.test(order ?? "")) fail(doc.filename, "order must be an integer");
  const orderKey = `${sectionOrder}:${section}:${order}`;
  if (orderKeys.has(orderKey)) {
    fail(doc.filename, `duplicates navigation order with ${orderKeys.get(orderKey)}`);
  } else {
    orderKeys.set(orderKey, doc.filename);
  }

  if (doc.content.includes("\u2014")) fail(doc.filename, "contains a Unicode em dash");

  for (const link of match[2].matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const href = link[1].trim();
    if (/^(?:https?:|mailto:)/.test(href)) continue;

    const [path, fragment] = href.split("#", 2);
    const targetSlug = path ? path.replace(/^\/docs\//, "").replace(/^\.\//, "") : doc.slug;
    const target = docs.get(targetSlug);
    if (!target) {
      fail(doc.filename, `links to missing documentation page: ${href}`);
      continue;
    }

    if (fragment) {
      const targetBody = target.content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/)?.[1] ?? "";
      const targetHeadings = new Set(
        Array.from(targetBody.matchAll(/^#{2,3}\s+(.+)$/gm), (heading) => headingId(heading[1])),
      );
      if (!targetHeadings.has(fragment)) fail(doc.filename, `links to missing heading: ${href}`);
    }
  }

  for (const group of match[2].matchAll(/:::language-snippet\n([\s\S]*?)\n:::/g)) {
    for (const language of ["typescript", "python", "curl"]) {
      if (!new RegExp("^```" + language + "(?:\\s|$)", "m").test(group[1])) {
        fail(doc.filename, `language snippet is missing ${language}`);
      }
    }
  }
}

const isolatedGuides = {
  "python-sdk": ["typescript", "javascript", "curl"],
  "typescript-sdk": ["python", "curl"],
  "http-api": ["typescript", "javascript", "python"],
};

for (const [slug, forbiddenLanguages] of Object.entries(isolatedGuides)) {
  const doc = docs.get(slug);
  if (!doc) {
    fail(`${slug}.md`, "required language guide is missing");
    continue;
  }
  if (doc.content.includes(":::language-snippet")) {
    fail(doc.filename, "dedicated language guides must not contain a language picker");
  }
  for (const language of forbiddenLanguages) {
    if (new RegExp("^```" + language + "(?:\\s|$)", "m").test(doc.content)) {
      fail(doc.filename, `contains a ${language} code fence`);
    }
  }
}

for (const slug of ["api-reference", "typescript-reference", "python-reference", "event-reference"]) {
  const doc = docs.get(slug);
  if (!doc?.content.includes("https://github.com/runtraice/traice-sdk")) {
    fail(`${slug}.md`, "reference documentation must link to the public source repository");
  }
}

if (failures.length > 0) {
  console.error("Documentation verification failed:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Documentation verification passed for ${docs.size} pages.`);
}
