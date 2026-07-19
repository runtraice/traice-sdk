import Link from "next/link";
import { ArrowRight, Radio, ShieldCheck, Terminal } from "lucide-react";
import { LanguageSnippet, type LanguageSnippets } from "./components/LanguageSnippet";
import { allDocs } from "./lib/docs";

export default function HomePage() {
  const docs = allDocs();
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
      code: 'curl -X POST "https://runtraice.com/api/v1/events" \\\n+  -H "authorization: Bearer $TRAICE_API_KEY"',
    },
  };

  return (
    <main>
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">Public SDKs and coding-agent collectors</p>
          <h1>trAIce SDK</h1>
          <p>
            Attribute product LLM costs with `@traice/sdk`, then collect internal coding-agent usage with one local
            collector for Claude Code, Codex, and future adapters.
          </p>
          <div className="hero-actions">
            <Link className="primary-link" href="/docs/install">
              Start the install guide
              <ArrowRight size={16} />
            </Link>
            <Link className="secondary-link" href="/docs/claude-code">
              Install Claude Code collector
            </Link>
          </div>
        </div>
        <div aria-label="SDK examples">
          <LanguageSnippet snippets={snippets} />
        </div>
      </section>

      <section className="feature-grid" aria-label="Documentation areas">
        <Link href="/docs/install" className="feature-card">
          <Terminal size={20} />
          <h2>Install Guide</h2>
          <p>Sign in, create an API key, and send product or internal-spend events.</p>
        </Link>
        <Link href="/docs/collector-overview" className="feature-card">
          <Radio size={20} />
          <h2>Agent Collectors</h2>
          <p>Normalize local agent telemetry into the trAIce Internal Spend endpoint.</p>
        </Link>
        <Link href="/docs/privacy" className="feature-card">
          <ShieldCheck size={20} />
          <h2>Privacy Defaults</h2>
          <p>Prompts and outputs stay off unless an organization explicitly opts in.</p>
        </Link>
      </section>

      <section className="doc-list">
        <h2>Docs</h2>
        <div>
          {docs.map((doc) => (
            <Link href={`/docs/${doc.slug}`} key={doc.slug}>
              <span>{doc.title}</span>
              <small>{doc.excerpt}</small>
            </Link>
          ))}
        </div>
      </section>
    </main>
  );
}
