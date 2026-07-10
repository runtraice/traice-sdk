import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight, BookOpen, Github, Home, Package } from "lucide-react";
import { CommandMenu } from "./components/CommandMenu";
import { allDocs } from "./lib/docs";
import "./globals.css";

const APP_URL = "https://www.runtraice.com/app/dashboard";
const HOME_URL = "https://www.runtraice.com";

export const metadata: Metadata = {
  title: "trAIce SDK Docs",
  description: "Public SDK and coding-agent collector documentation for trAIce.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const docs = allDocs();

  return (
    <html lang="en">
      <body>
        <CommandMenu docs={docs} />
        <header className="site-header">
          <Link className="brand" href="/">
            <span className="brand-mark" aria-hidden="true" />
            <span>trAIce SDK</span>
          </Link>
          <nav aria-label="Primary navigation">
            <a href={HOME_URL}>
              <Home size={16} />
              trAIce home
            </a>
            <Link href="/docs/sdk-quickstart">
              <Package size={16} />
              SDK
            </Link>
            <Link href="/docs/collector-overview">
              <BookOpen size={16} />
              Collectors
            </Link>
            <a href="https://github.com/runtraice/traice-sdk">
              <Github size={16} />
              GitHub
            </a>
            <a className="app-link" href={APP_URL}>
              Go to app
              <ArrowUpRight size={16} />
            </a>
          </nav>
        </header>
        {children}
      </body>
    </html>
  );
}
