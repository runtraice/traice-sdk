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

After the PR merges, the Release workflow creates or updates the Changesets
version PR. Merging that version PR runs the workflow again and publishes the
new package versions to npm. `workflow_dispatch` is available as a recovery
path. Publication requires the `@traice` npm scope and an Actions-visible
`NPM_TOKEN` with publish access.
