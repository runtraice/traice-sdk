"use client";

import { Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { DocSummary } from "../lib/docs";

export function CommandMenu({ docs }: { docs: DocSummary[] }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(true);
      }
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const results = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return docs.slice(0, 8);
    return docs
      .map((doc) => ({ doc, score: scoreDoc(doc, normalized) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((entry) => entry.doc);
  }, [docs, query]);

  return (
    <>
      <button className="search-trigger" onClick={() => setOpen(true)} type="button">
        <Search size={16} />
        <span>Search</span>
        <kbd>⌘K</kbd>
      </button>
      {open ? (
        <div className="command-backdrop" role="presentation" onMouseDown={() => setOpen(false)}>
          <div
            className="command-menu"
            role="dialog"
            aria-modal="true"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="command-input">
              <Search size={18} />
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search docs"
              />
              <button aria-label="Close search" onClick={() => setOpen(false)} type="button">
                <X size={18} />
              </button>
            </div>
            <div className="command-results">
              {results.map((doc) => (
                <a href={`/docs/${doc.slug}`} key={doc.slug}>
                  <span>{doc.title}</span>
                  <small>{doc.excerpt}</small>
                </a>
              ))}
              {results.length === 0 ? <p>No matches</p> : null}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function scoreDoc(doc: DocSummary, query: string): number {
  const title = doc.title.toLowerCase();
  const slug = doc.slug.toLowerCase();
  const body = doc.body.toLowerCase();
  let score = 0;
  if (title.includes(query)) score += 10;
  if (slug.includes(query)) score += 6;
  if (doc.excerpt.toLowerCase().includes(query)) score += 4;
  if (body.includes(query)) score += 1;
  return score;
}
