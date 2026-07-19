import { Children, isValidElement, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, ExternalLink, Github } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "../../components/CodeBlock";
import { DocsNavigation } from "../../components/DocsNavigation";
import { LanguageSnippet } from "../../components/LanguageSnippet";
import { allDocs, docBlocks, docBySlug, groupedDocs, headingId } from "../../lib/docs";

const GITHUB_ROOT = "https://github.com/runtraice/traice-sdk";

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
  const docs = allDocs();
  const sections = groupedDocs(docs);
  const currentIndex = docs.findIndex((item) => item.slug === doc.slug);
  const previous = currentIndex > 0 ? docs[currentIndex - 1] : null;
  const next = currentIndex < docs.length - 1 ? docs[currentIndex + 1] : null;
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  const sourceUrl = `${GITHUB_ROOT}/blob/main/${doc.sourcePath}`;
  const markdownComponents = createMarkdownComponents(basePath);

  return (
    <main className="doc-shell">
      <DocsNavigation currentSlug={doc.slug} sections={sections} />
      <article className="doc-content">
        <header className="doc-header">
          <div className="doc-breadcrumb">
            <Link href="/">Docs</Link>
            <span aria-hidden="true">/</span>
            <span>{doc.section}</span>
          </div>
          <h1>{doc.title}</h1>
          <p>{doc.excerpt}</p>
          <a className="source-link" href={sourceUrl} rel="noreferrer" target="_blank">
            <Github size={16} />
            View source
            <ExternalLink size={13} />
          </a>
        </header>
        {docBlocks(doc.body).map((block, index) =>
          block.type === "markdown" ? (
            <ReactMarkdown components={markdownComponents} key={`markdown-${index}`} remarkPlugins={[remarkGfm]}>
              {block.content}
            </ReactMarkdown>
          ) : (
            <LanguageSnippet key={`languages-${index}`} snippets={block.snippets} />
          ),
        )}
        <nav className="doc-pagination" aria-label="Previous and next documentation pages">
          {previous ? (
            <Link href={`/docs/${previous.slug}`}>
              <small>
                <ArrowLeft size={14} /> Previous
              </small>
              <span>{previous.title}</span>
            </Link>
          ) : (
            <span />
          )}
          {next ? (
            <Link href={`/docs/${next.slug}`}>
              <small>
                Next <ArrowRight size={14} />
              </small>
              <span>{next.title}</span>
            </Link>
          ) : null}
        </nav>
      </article>
      <aside className="doc-toc" aria-label="On this page">
        <h2>On this page</h2>
        {doc.headings.length > 0 ? (
          <nav>
            {doc.headings.map((heading) => (
              <a data-level={heading.level} href={`#${heading.id}`} key={`${heading.id}-${heading.level}`}>
                {heading.text}
              </a>
            ))}
          </nav>
        ) : (
          <p>No sections</p>
        )}
      </aside>
    </main>
  );
}

function createMarkdownComponents(basePath: string): Components {
  return {
    a({ node, href = "", children, ...props }) {
      void node;
      const external = /^https?:\/\//.test(href);
      const resolvedHref = href.startsWith("/docs/") ? `${basePath}${href}` : href;
      return (
        <a {...props} href={resolvedHref} {...(external ? { rel: "noreferrer", target: "_blank" } : {})}>
          {children}
          {external ? <ExternalLink aria-hidden="true" className="inline-external" size={12} /> : null}
        </a>
      );
    },
    h2({ node, children, ...props }) {
      void node;
      return (
        <h2 {...props} id={headingId(nodeText(children))}>
          {children}
        </h2>
      );
    },
    h3({ node, children, ...props }) {
      void node;
      return (
        <h3 {...props} id={headingId(nodeText(children))}>
          {children}
        </h3>
      );
    },
    pre({ node, children, ...props }) {
      void node;
      const child = Children.toArray(children)[0];
      if (isValidElement<{ children?: ReactNode; className?: string }>(child)) {
        const language = child.props.className?.replace(/^language-/, "") ?? "text";
        return <CodeBlock code={nodeText(child.props.children).replace(/\n$/, "")} language={language} />;
      }
      return <pre {...props}>{children}</pre>;
    },
    table({ node, ...props }) {
      void node;
      return (
        <div className="doc-table-wrap">
          <table {...props} />
        </div>
      );
    },
  };
}

function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return "";
}
