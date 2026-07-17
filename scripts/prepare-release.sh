#!/usr/bin/env bash

set -euo pipefail

github_repo="${TRAICE_SDK_REPO:-runtraice/traice-sdk}"
set_secret=true
prepare_pr=true
repo_root=""
temp_root=""
worktree_dir=""
npm_token=""

usage() {
  cat <<'EOF'
Usage: npm run release:prepare -- [--secret-only | --prepare-only]

Securely configures the traice-sdk NPM_TOKEN GitHub Actions secret and opens a
reviewable Changesets version PR. The script never writes the token to disk and
never merges or publishes packages itself.

Options:
  --secret-only   Configure NPM_TOKEN without preparing a version PR.
  --prepare-only  Prepare a version PR using an already-configured NPM_TOKEN.
  -h, --help      Show this help.

Set TRAICE_SDK_REPO to override the default GitHub repository.
EOF
}

cleanup() {
  npm_token=""

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
    --secret-only)
      prepare_pr=false
      ;;
    --prepare-only)
      set_secret=false
      ;;
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

if [[ "$set_secret" == false && "$prepare_pr" == false ]]; then
  echo "Choose only one of --secret-only or --prepare-only." >&2
  exit 2
fi

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

if [[ "$set_secret" == true ]]; then
  if [[ ! -r /dev/tty ]]; then
    echo "A terminal is required for the secure npm token prompt." >&2
    exit 1
  fi

  printf 'Paste the granular npm token for the @traice scope: ' > /dev/tty
  IFS= read -r -s npm_token < /dev/tty
  printf '\n' > /dev/tty

  if [[ -z "$npm_token" ]]; then
    echo "Token cannot be empty." >&2
    exit 1
  fi

  printf '%s' "$npm_token" | gh secret set NPM_TOKEN --repo "$github_repo" --app actions
  npm_token=""

  if ! gh secret list --repo "$github_repo" --app actions | awk '{print $1}' | grep -qx NPM_TOKEN; then
    echo "GitHub did not report an NPM_TOKEN secret after configuration." >&2
    exit 1
  fi

  echo "Configured the NPM_TOKEN Actions secret for $github_repo."
fi

if [[ "$prepare_pr" == false ]]; then
  exit 0
fi

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
