import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface DocSummary {
  slug: string;
  title: string;
  excerpt: string;
  body: string;
  order: number;
}

const docsDir = join(process.cwd(), "content/docs");

export function allDocs(): DocSummary[] {
  if (!existsSync(docsDir)) return [];
  return readdirSync(docsDir)
    .filter((file) => file.endsWith(".md"))
    .map((file) => parseDoc(file.replace(/\.md$/, ""), readFileSync(join(docsDir, file), "utf8")))
    .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
}

export function docBySlug(slug: string): DocSummary | null {
  return allDocs().find((doc) => doc.slug === slug) ?? null;
}

function parseDoc(slug: string, raw: string): DocSummary {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  const frontmatter = match?.[1] ?? "";
  const body = (match?.[2] ?? raw).trim();
  const title = frontmatter.match(/^title:\s*(.+)$/m)?.[1]?.trim() ?? titleFromBody(body) ?? slug;
  const excerpt = frontmatter.match(/^excerpt:\s*(.+)$/m)?.[1]?.trim() ?? "";
  const order = Number(frontmatter.match(/^order:\s*(\d+)$/m)?.[1] ?? "999");
  return { slug, title, excerpt, body, order };
}

function titleFromBody(body: string): string | null {
  return body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? null;
}
