# Repository instructions

## Toolchain

- Agents use pnpm 10.34.5. Enable it with `corepack enable` and
  `corepack prepare pnpm@10.34.5 --activate`.
- `pnpm-lock.yaml` is the canonical dependency lockfile and CI uses pnpm.
  Developers may use npm, Yarn, or Bun locally, but do not commit or replace the
  canonical lockfile with an alternate package manager's lockfile.
- Use Node.js 20 or newer. Python 3 is also required for the full
  `pnpm run check` suite.

## Copywriting

- Do not use Unicode em dash characters (U+2014).
- Rewrite the sentence with a period, comma, colon, or parentheses instead.
- Keep package, CLI, and documentation copy direct, specific, and grounded in behavior that exists today.

## Next.js documentation app

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

The documentation app uses a Next.js version with breaking changes. APIs, conventions, and file structure may differ from training data. Read the relevant guide in `node_modules/next/dist/docs/` before changing the docs app. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->
