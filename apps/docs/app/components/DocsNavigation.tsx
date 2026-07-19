import Link from "next/link";
import type { DocSection } from "../lib/docs";

interface DocsNavigationProps {
  currentSlug: string;
  sections: DocSection[];
}

export function DocsNavigation({ currentSlug, sections }: DocsNavigationProps) {
  const navigation = sections.map((section) => (
    <section className="sidebar-section" key={section.title}>
      <h2>{section.title}</h2>
      {section.docs.map((item) => (
        <Link data-active={item.slug === currentSlug} href={`/docs/${item.slug}`} key={item.slug}>
          {item.title}
        </Link>
      ))}
    </section>
  ));

  return (
    <>
      <aside className="doc-sidebar" aria-label="Documentation navigation">
        {navigation}
      </aside>
      <details className="mobile-doc-nav">
        <summary>Documentation menu</summary>
        <nav aria-label="Documentation navigation">{navigation}</nav>
      </details>
    </>
  );
}
