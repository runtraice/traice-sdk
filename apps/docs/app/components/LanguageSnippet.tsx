"use client";

import { useId, useState } from "react";

export type SnippetLanguage = "typescript" | "python" | "curl";

export type Snippet = {
  code: string;
  install?: string;
};

export type LanguageSnippets = Record<SnippetLanguage, Snippet>;

const LANGUAGES: Array<{ id: SnippetLanguage; label: string }> = [
  { id: "typescript", label: "TypeScript" },
  { id: "python", label: "Python" },
  { id: "curl", label: "cURL" },
];

export function LanguageSnippet({ snippets, className = "" }: { snippets: LanguageSnippets; className?: string }) {
  const [language, setLanguage] = useState<SnippetLanguage>("typescript");
  const [copied, setCopied] = useState(false);
  const tabsId = useId();
  const snippet = snippets[language];

  async function copy() {
    try {
      const value = snippet.install ? `${snippet.install}\n\n${snippet.code}` : snippet.code;
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be unavailable in insecure contexts.
    }
  }

  return (
    <div className={`language-snippet ${className}`}>
      <div className="language-tabs" role="tablist" aria-label="Code language">
        {LANGUAGES.map((item) => (
          <button
            key={item.id}
            id={`${tabsId}-${item.id}`}
            type="button"
            role="tab"
            aria-selected={language === item.id}
            onClick={() => setLanguage(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="language-panel" role="tabpanel" aria-labelledby={`${tabsId}-${language}`}>
        {snippet.install ? (
          <pre>
            <code>{snippet.install}</code>
          </pre>
        ) : null}
        <pre>
          <code>{snippet.code}</code>
        </pre>
        <button type="button" className="copy-snippet" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
