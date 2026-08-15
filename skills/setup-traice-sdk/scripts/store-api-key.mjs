#!/usr/bin/env node

import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const envIndex = args.indexOf("--target");
const requestedPath = envIndex >= 0 ? args[envIndex + 1] : ".env.local";

if (args.includes("--help") || !requestedPath) {
  console.log("Usage: store-api-key.mjs [--target PATH] [--check]");
  process.exit(requestedPath ? 0 : 2);
}

const envFile = resolve(requestedPath);
assertSafeTarget(envFile);

if (checkOnly) {
  const configured = readEnvironmentFile(envFile).some((line) => /^\s*(?:export\s+)?TRAICE_API_KEY\s*=/.test(line));
  console.log(
    configured
      ? `TRAICE_API_KEY is configured in ${requestedPath}.`
      : `TRAICE_API_KEY is not configured in ${requestedPath}.`,
  );
  process.exit(configured ? 0 : 1);
}

const apiKey = (process.env.TRAICE_API_KEY?.trim() || (await readHiddenSecret("Paste the trAIce API key: "))).trim();
if (!/^lm_live_[A-Za-z0-9_-]{16,}$/.test(apiKey)) {
  fail("The value does not look like a trAIce workspace API key.");
}

const existing = readEnvironmentFile(envFile);
const kept = existing.filter((line) => !/^\s*(?:export\s+)?TRAICE_API_KEY\s*=/.test(line));
const newline = existsSync(envFile) && readFileSync(envFile, "utf8").includes("\r\n") ? "\r\n" : "\n";
const content = [...kept, `TRAICE_API_KEY=${apiKey}`].join(newline) + newline;

mkdirSync(dirname(envFile), { recursive: true, mode: 0o700 });
process.umask(0o077);
writeFileSync(envFile, content, { encoding: "utf8", mode: 0o600 });
try {
  chmodSync(envFile, 0o600);
} catch {
  // Windows applies the current user's inherited ACL.
}
console.log(`Stored TRAICE_API_KEY in ${requestedPath} without displaying it.`);

function assertSafeTarget(path) {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) fail("Refusing to write an API key through a symlink.");

  const rootResult = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (rootResult.status !== 0) return;
  const root = resolve(rootResult.stdout.trim());
  const repoPath = relative(root, path);
  if (!repoPath || repoPath.startsWith("..")) fail("The environment file must be inside the current Git repository.");

  const tracked = spawnSync("git", ["-C", root, "ls-files", "--error-unmatch", "--", repoPath], {
    stdio: "ignore",
  });
  if (tracked.status === 0) fail(`Refusing to store a secret in tracked file ${repoPath}.`);

  const ignored = spawnSync("git", ["-C", root, "check-ignore", "-q", "--", repoPath], { stdio: "ignore" });
  if (ignored.status !== 0) fail(`Add ${repoPath} to .gitignore before storing the key.`);
}

function readEnvironmentFile(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((line, index, lines) => line || index < lines.length - 1);
}

async function readHiddenSecret(prompt) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    fail("Run this command in an interactive terminal or set TRAICE_API_KEY for this process.");
  }
  process.stderr.write(prompt);
  process.stdin.setEncoding("utf8");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let value = "";

  return await new Promise((resolveSecret) => {
    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === "\u0003") {
          cleanup();
          process.stderr.write("\n");
          process.exit(130);
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          process.stderr.write("\n");
          resolveSecret(value);
          return;
        }
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else if (character >= " ") value += character;
      }
    };
    process.stdin.on("data", onData);
  });
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
