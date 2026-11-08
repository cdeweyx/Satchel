#!/usr/bin/env bash
# Squash-merges a PR into main only when an agent review said "Ready" for its exact head.
# Usage: scripts/merge.sh <pr-number>
# Refuses unless: base is main; head isn't main; no `needs-human` label; and some PR
# comment or review body has a first line exactly `Verdict: Ready @ <40-char head sha>`.
set -euo pipefail

pr="${1:-}"
if ! [[ "$pr" =~ ^[0-9]+$ ]]; then
  echo "usage: scripts/merge.sh <pr-number>" >&2
  exit 2
fi

refuse() {
  echo "merge.sh: refusing PR #$pr: $1" >&2
  exit 1
}

info="$(gh pr view "$pr" --json baseRefName,headRefName,headRefOid,labels)"
base="$(jq -r '.baseRefName' <<<"$info")"
head_ref="$(jq -r '.headRefName' <<<"$info")"
head_sha="$(jq -r '.headRefOid' <<<"$info")"

[ "$base" = "main" ] || refuse "base is '$base', not main"
[ "$head_ref" != "main" ] || refuse "head is main"
[[ "$head_sha" =~ ^[0-9a-f]{40}$ ]] || refuse "couldn't read the head sha"
if jq -e '.labels[] | select(.name == "needs-human")' <<<"$info" >/dev/null; then
  refuse "labelled needs-human"
fi

# First line of every comment and review body, CRLF and trailing whitespace stripped.
first_lines="$(gh pr view "$pr" --json comments,reviews --jq \
  '[.comments[].body, .reviews[].body] | .[] | split("\n")[0] | sub("\r$"; "") | sub("[[:space:]]+$"; "")')"

wanted="Verdict: Ready @ $head_sha"
if ! grep -qxF -- "$wanted" <<<"$first_lines"; then
  refuse "no Ready verdict for $head_sha"
fi

gh pr merge "$pr" --squash --delete-branch --match-head-commit "$head_sha"
