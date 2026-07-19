"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";

const LANGUAGE_LABELS: Record<string, string> = {
  bash: "Shell",
  curl: "cURL",
  javascript: "JavaScript",
  json: "JSON",
  python: "Python",
  sh: "Shell",
  text: "Text",
  toml: "TOML",
  ts: "TypeScript",
  typescript: "TypeScript",
};

export function CodeBlock({ code, language = "text" }: { code: string; language?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be unavailable in insecure contexts.
    }
  }

  return (
    <div className="code-block">
      <div className="code-block-header">
        <span>{LANGUAGE_LABELS[language] ?? language}</span>
        <button type="button" onClick={copy} aria-label="Copy code">
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>
        <code className={`language-${language}`}>{code}</code>
      </pre>
    </div>
  );
}
