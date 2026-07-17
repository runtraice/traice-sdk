# Contributing

Thanks for helping improve trAIce.

## Local Setup

```sh
npm install
npm run check
```

## Development Standards

- Write TypeScript for package source.
- Keep public APIs usable from both TypeScript and JavaScript.
- Add or update tests for behavior changes.
- Run `npm run check` before opening a pull request.
- Do not commit secrets, `.env` files, private SaaS code, database schemas, migrations, customer data, or local collector state.

## Pull Requests

Open pull requests against `main`. Include:

- What changed.
- Why it changed.
- How it was tested.
- Any migration notes for users.

## Releases

Packages are released from `main` with Changesets. Add a changeset to every PR
that changes a published package:

```sh
npm run changeset
```

After package PRs merge, a maintainer prepares the reviewable version PR from
an up-to-date `main` branch:

```sh
git switch -c release/version-packages
npm ci
npm run version
git add .
git commit -m "Version packages"
git push -u origin release/version-packages
gh pr create --title "Version packages" --body "Apply pending Changesets."
```

The Release workflow sees pending Changesets on ordinary `main` merges and does
not publish. Merging the version PR consumes those Changesets, bumps package
versions, and automatically publishes the new versions to npm.
`workflow_dispatch` reruns the same detection and is available as a recovery
path; it does not bypass the version-PR gate. Publication requires the
`@traice` npm scope and an Actions-visible `NPM_TOKEN` with publish access.
