#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();

const ignoredDirs = new Set([".git", ".next", "coverage", "dist", "node_modules", "out"]);
const ignoredFiles = new Set(["package-lock.json"]);

const bannedPathFragments = [
  "/.env",
  "/.env.",
  "/.vercel",
  "/apps/web",
  "/prisma",
  "/migrations",
  "/.traice",
  "/.traice-",
  "/.traice-costs",
];

const bannedText = [
  "shmulikdav",
  "git@ssh.github.com:runtraice/trAIce",
  "github.com/runtraice/trAIce",
  "POSTGRES_PRISMA_URL",
  "POSTGRES_URL_NON_POOLING",
  "DATABASE_URL",
  "VERCEL_PROJECT_ID",
  "VERCEL_ORG_ID",
  "apps/web/.env",
  "internal-spend-poc",
  "@traice/codex-collector",
];

const suspiciousSecretPatterns = [
  /traice_[a-zA-Z0-9_-]{24,}/,
  /sk-[a-zA-Z0-9_-]{24,}/,
  /xox[baprs]-[a-zA-Z0-9-]{24,}/,
  /ghp_[a-zA-Z0-9]{30,}/,
  /gho_[a-zA-Z0-9]{30,}/,
];

const failures = [];

for (const file of walk(root)) {
  const rel = `/${relative(root, file)}`;
  if (rel === "/scripts/verify-public-surface.mjs") continue;

  if (bannedPathFragments.some((fragment) => rel.includes(fragment))) {
    failures.push(`${rel}: banned public path`);
    continue;
  }

  if (ignoredFiles.has(rel.slice(1))) continue;

  const text = readFileSync(file, "utf8");
  for (const banned of bannedText) {
    if (text.includes(banned)) failures.push(`${rel}: contains banned text "${banned}"`);
  }

  for (const pattern of suspiciousSecretPatterns) {
    if (pattern.test(text)) failures.push(`${rel}: matches suspicious secret pattern ${pattern}`);
  }
}

if (failures.length > 0) {
  console.error("Public surface verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Public surface verification passed.");

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (ignoredDirs.has(entry)) continue;
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      yield* walk(path);
    } else if (stat.isFile() && isTextFile(path)) {
      yield path;
    }
  }
}

function isTextFile(path) {
  return /\.(cjs|css|html|js|json|jsx|md|mdx|mjs|toml|ts|tsx|txt|yml|yaml)$/.test(path);
}
