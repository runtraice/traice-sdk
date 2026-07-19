import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface DocSummary {
  slug: string;
  title: string;
  excerpt: string;
  body: string;
  order: number;
}

export type DocBlock =
  | { type: "markdown"; content: string }
  | {
      type: "languages";
      snippets: Record<"typescript" | "python" | "curl", { code: string; install?: string }>;
    };

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

export function docBlocks(body: string): DocBlock[] {
  const lines = body.split("\n");
  const blocks: DocBlock[] = [];
  let markdown: string[] = [];

  function flushMarkdown() {
    const content = markdown.join("\n").trim();
    if (content) blocks.push({ type: "markdown", content });
    markdown = [];
  }

  for (let index = 0; index < lines.length; index++) {
    if (lines[index].trim() !== ":::language-snippet") {
      markdown.push(lines[index]);
      continue;
    }

    flushMarkdown();
    const snippets: Partial<Record<"typescript" | "python" | "curl", { code: string; install?: string }>> = {};
    index++;
    while (index < lines.length && lines[index].trim() !== ":::") {
      if (!lines[index].trim()) {
        index++;
        continue;
      }
      const fence = lines[index].match(/^```(typescript|python|curl)(?:\s+install="([^"]+)")?\s*$/);
      if (!fence) throw new Error(`Invalid language snippet fence: ${lines[index]}`);
      const language = fence[1] as "typescript" | "python" | "curl";
      const code: string[] = [];
      index++;
      while (index < lines.length && lines[index].trim() !== "```") {
        code.push(lines[index]);
        index++;
      }
      if (index >= lines.length) throw new Error(`Unclosed ${language} language snippet`);
      snippets[language] = { code: code.join("\n"), ...(fence[2] ? { install: fence[2] } : {}) };
      index++;
    }
    if (index >= lines.length || lines[index].trim() !== ":::") {
      throw new Error("Unclosed language snippet group");
    }
    if (!snippets.typescript || !snippets.python || !snippets.curl) {
      throw new Error("Every language snippet must include TypeScript, Python, and cURL");
    }
    blocks.push({
      type: "languages",
      snippets: snippets as Record<"typescript" | "python" | "curl", { code: string; install?: string }>,
    });
  }
  flushMarkdown();
  return blocks;
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
