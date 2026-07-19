import { notFound } from "next/navigation";
import ReactMarkdown from "react-markdown";
import { LanguageSnippet } from "../../components/LanguageSnippet";
import { allDocs, docBlocks, docBySlug } from "../../lib/docs";

export function generateStaticParams() {
  return allDocs().map((doc) => ({ slug: doc.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const doc = docBySlug(slug);
  return {
    title: doc ? `${doc.title} | trAIce SDK Docs` : "trAIce SDK Docs",
    description: doc?.excerpt,
  };
}

export default async function DocPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const doc = docBySlug(slug);
  if (!doc) notFound();
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

  return (
    <main className="doc-shell">
      <aside className="doc-sidebar" aria-label="Documentation navigation">
        {allDocs().map((item) => (
          <a data-active={item.slug === doc.slug} href={`${basePath}/docs/${item.slug}`} key={item.slug}>
            {item.title}
          </a>
        ))}
      </aside>
      <article className="doc-content">
        {docBlocks(doc.body).map((block, index) =>
          block.type === "markdown" ? (
            <ReactMarkdown key={`markdown-${index}`}>{block.content}</ReactMarkdown>
          ) : (
            <LanguageSnippet key={`languages-${index}`} snippets={block.snippets} />
          ),
        )}
      </article>
    </main>
  );
}
