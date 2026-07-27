import Link from "next/link";
import { ArrowRight, Braces, Code2, Radio, Terminal } from "lucide-react";
import { LanguageSnippet, type LanguageSnippets } from "./components/LanguageSnippet";
import { allDocs, groupedDocs } from "./lib/docs";

export default function HomePage() {
  const docs = allDocs();
  const sections = groupedDocs(docs);
  const snippets: LanguageSnippets = {
    typescript: {
      install: "npm install @traice/sdk",
      code: 'import { configure, meter } from "@traice/sdk";',
    },
    python: {
      install: "pip install traice-sdk",
      code: "from traice import configure, track",
    },
    curl: {
      code: 'curl -X POST "https://runtraice.com/api/v1/events" \\\n  -H "authorization: Bearer $TRAICE_API_KEY"',
    },
  };

  return (
    <main>
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">Public SDKs and coding-agent collectors</p>
          <h1>Instrument every LLM cost.</h1>
          <p>
            Attribute product LLM spend to customers, users, features, and workflows. Use the TypeScript SDK, Python
            SDK, or the HTTP API, then collect internal coding-agent usage with the same public repository.
          </p>
          <div className="hero-actions">
            <Link className="primary-link" href="/docs/sdk-quickstart">
              Choose an integration
              <ArrowRight size={16} />
            </Link>
            <Link className="secondary-link" href="/docs/api-reference">
              Browse the API reference
            </Link>
          </div>
        </div>
        <div aria-label="SDK examples">
          <LanguageSnippet snippets={snippets} />
        </div>
      </section>

      <section className="feature-grid" aria-label="Product SDK integrations">
        <Link href="/docs/typescript-sdk" className="feature-card">
          <Terminal size={20} />
          <h2>TypeScript and Node.js</h2>
          <p>Meter provider calls, streams, frameworks, adapters, and active request guardrails.</p>
        </Link>
        <Link href="/docs/python-sdk" className="feature-card">
          <Code2 size={20} />
          <h2>Python</h2>
          <p>Track sync and async OpenAI, Anthropic, LangChain, and LangGraph calls.</p>
        </Link>
        <Link href="/docs/http-api" className="feature-card">
          <Braces size={20} />
          <h2>HTTP and cURL</h2>
          <p>Send the product usage event contract from any runtime without an SDK.</p>
        </Link>
      </section>

      <section className="feature-grid secondary-features" aria-label="Additional documentation areas">
        <Link href="/docs/install" className="feature-card compact-card">
          <Terminal size={20} />
          <h2>Installation</h2>
          <p>Create a workspace key and send the first event.</p>
        </Link>
        <Link href="/docs/collector-overview" className="feature-card compact-card">
          <Radio size={20} />
          <h2>Internal Spend</h2>
          <p>Collect Claude Code and Codex usage by employee and team.</p>
        </Link>
        <Link href="/docs/api-reference" className="feature-card compact-card">
          <Braces size={20} />
          <h2>API Reference</h2>
          <p>Review signatures, event contracts, and links to source.</p>
        </Link>
      </section>

      <section className="doc-list">
        <div className="section-heading">
          <p className="eyebrow">Documentation map</p>
          <h2>Everything in one place</h2>
        </div>
        {sections.map((section) => (
          <section className="doc-list-section" key={section.title}>
            <h3>{section.title}</h3>
            <div>
              {section.docs.map((doc) => (
                <Link href={`/docs/${doc.slug}`} key={doc.slug}>
                  <span>{doc.title}</span>
                  <small>{doc.excerpt}</small>
                </Link>
              ))}
            </div>
          </section>
        ))}
      </section>
    </main>
  );
}
