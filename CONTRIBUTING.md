# Contributing

Thanks for helping improve trAIce.

## Local Setup

```sh
npm install
npm run check
```

## Development Standards

- Write TypeScript for npm package source and typed Python for `packages/python`.
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

After package PRs merge, a maintainer prepares the reviewable version PR with
the release helper:

```sh
npm run release:prepare
```

The helper runs the full package checks in a temporary worktree and opens the
version PR. It never merges the PR or publishes directly.

The Release workflow sees pending Changesets on ordinary `main` merges and does
not publish. Merging the version PR consumes those Changesets, bumps package
versions, and automatically publishes the new versions to npm.
`workflow_dispatch` reruns the same detection and is available as a recovery
path; it does not bypass the version-PR gate. Publication requires the
`@traice` npm scope's trusted-publisher entries for
`runtraice/traice-sdk/.github/workflows/release.yml`. GitHub Actions obtains a
short-lived npm credential through OIDC for each release, so there is no npm
publish token to store or rotate.
SDK npm releases are independent of the private trAIce application's GCP Cloud
Build and Terraform deployment pipeline.

The Python distribution has an independent version in
`packages/python/src/traice/_version.py`. Run its tests and build before tagging:

```sh
npm run python:check
cd packages/python
python -m build
```

After the version and changelog are reviewed and merged to `main`, the existing
Release workflow checks PyPI. If that version does not exist, it builds and
publishes `traice-sdk` through PyPI trusted publishing. Existing versions are
skipped, so a workflow retry is safe. The PyPI project must trust
`runtraice/traice-sdk/.github/workflows/release.yml` with the `pypi` GitHub
environment. Manual workflow dispatch uses the same version check and is a
recovery path.
