#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

upstream_branch="main"
patch_branch="openai-native-controls"

if [[ "$(git branch --show-current)" != "$patch_branch" ]]; then
  echo "Run this from $patch_branch; current branch is $(git branch --show-current)." >&2
  exit 1
fi
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Worktree must be clean before updating upstream." >&2
  exit 1
fi
if ! command -v stg >/dev/null 2>&1; then
  echo "StGit (stg) is required; see PATCHES.md for installation." >&2
  exit 1
fi

# Validate the stack before moving either branch.
stg series >/dev/null

git fetch upstream
git fetch origin
git switch main
git merge --ff-only "upstream/$upstream_branch"
git branch --set-upstream-to="upstream/$upstream_branch" main
git switch "$patch_branch"

if ! stg rebase --merged "upstream/$upstream_branch"; then
  cat >&2 <<'EOF'
StGit stopped while replaying a patch. Resolve the current patch semantically,
then stage the resolution, run `stg refresh`, and continue with `stg push --all`.
Inspect `stg series` after each patch. Do not force-push automatically.
EOF
  exit 1
fi

echo "Patch stack is now based on upstream/$upstream_branch. Review it and run tests before pushing."
