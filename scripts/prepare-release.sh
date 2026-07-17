#!/usr/bin/env bash

set -euo pipefail

github_repo="${TRAICE_SDK_REPO:-runtraice/traice-sdk}"
repo_root=""
temp_root=""
worktree_dir=""

usage() {
  cat <<'EOF'
Usage: npm run release:prepare

Opens a reviewable Changesets version PR. Merging that PR lets the release
workflow publish through npm trusted publishing (OIDC), without an npm token.
The script never merges or publishes packages itself.

Options:
  -h, --help      Show this help.

Set TRAICE_SDK_REPO to override the default GitHub repository.
EOF
}

cleanup() {
  if [[ -n "$worktree_dir" && -d "$worktree_dir" && -n "$repo_root" ]]; then
    git -C "$repo_root" worktree remove --force "$worktree_dir" >/dev/null 2>&1 || true
  fi

  if [[ -n "$temp_root" && -d "$temp_root" ]]; then
    rmdir "$temp_root" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

for command in git gh npm; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required command not found: $command" >&2
    exit 1
  fi
done

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$repo_root" || ! -f "$repo_root/.changeset/config.json" ]]; then
  echo "Run this command from the traice-sdk repository." >&2
  exit 1
fi

gh auth status --hostname github.com >/dev/null

existing_pr="$(gh pr list --repo "$github_repo" --state open --search 'Version packages in:title' --json url --jq '.[0].url // empty')"
if [[ -n "$existing_pr" ]]; then
  echo "A version PR is already open: $existing_pr"
  exit 0
fi

git -C "$repo_root" fetch origin main

temp_root="$(mktemp -d "${TMPDIR:-/tmp}/traice-sdk-release.XXXXXX")"
worktree_dir="$temp_root/worktree"
git -C "$repo_root" worktree add --detach "$worktree_dir" origin/main >/dev/null

if ! find "$worktree_dir/.changeset" -maxdepth 1 -type f -name '*.md' ! -name 'README.md' -print -quit | grep -q .; then
  echo "No pending Changesets exist on origin/main; no version PR is needed."
  exit 0
fi

branch="release/version-packages-$(date -u +%Y%m%d%H%M%S)"

(
  cd "$worktree_dir"
  git switch -c "$branch"
  npm ci
  npm run version
  git diff --check
  npm run check

  if git diff --quiet; then
    echo "Changesets produced no version changes." >&2
    exit 1
  fi

  git add .
  git commit -m "Version packages"
  git push -u origin "$branch"
)

pr_body="$(cat <<'EOF'
## Summary

- apply the pending Changesets
- update package versions and changelogs

## Publish behavior

Merging this reviewed version PR triggers the SDK repository's GitHub Actions
release workflow and npm publication. It does not use the trAIce SaaS
repository's GCP Cloud Build or Terraform deployment path.

## Verification

- `npm run check`
- package tarball dry runs
- `git diff --check`
EOF
)"

pr_url="$(
  cd "$worktree_dir"
  gh pr create \
    --repo "$github_repo" \
    --base main \
    --head "$branch" \
    --title "Version packages" \
    --body "$pr_body"
)"

echo "Opened version PR: $pr_url"
echo "Review and merge it to publish; this script does not merge or publish directly."
