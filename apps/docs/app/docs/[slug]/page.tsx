import { notFound } from "next/navigation";
import ReactMarkdown from "react-markdown";
import { allDocs, docBySlug } from "../../lib/docs";

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

  return (
    <main className="doc-shell">
      <aside className="doc-sidebar" aria-label="Documentation navigation">
        {allDocs().map((item) => (
          <a data-active={item.slug === doc.slug} href={`/docs/${item.slug}`} key={item.slug}>
            {item.title}
          </a>
        ))}
      </aside>
      <article className="doc-content">
        <ReactMarkdown>{doc.body}</ReactMarkdown>
      </article>
    </main>
  );
}
