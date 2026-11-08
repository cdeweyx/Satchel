#!/usr/bin/env bash
# Claude Code Stop hook (.claude/settings.json): runs `npm run check` from this repo's
# root and blocks the session (exit 2) with the tail of the output when it fails.
set -uo pipefail

input="$(cat)"
# Already continuing because of this hook: let the session stop, no loops.
if printf '%s' "$input" | grep -Eq '"stop_hook_active"[[:space:]]*:[[:space:]]*true'; then
  exit 0
fi

root="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$root" || exit 0

if [ ! -d node_modules ]; then
  echo "stop-check: node_modules missing, run npm ci" >&2
  exit 0
fi

if output="$(npm run check 2>&1)"; then
  exit 0
fi

{
  echo "stop-check: npm run check failed. Last lines:"
  printf '%s\n' "$output" | tail -n 40
} >&2
exit 2
