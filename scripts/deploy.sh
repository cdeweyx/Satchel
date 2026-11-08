#!/usr/bin/env bash
# Deploys the Worker with its secrets and the two Notion IDs (D-14, revised in SAT-1).
# `secrets.required` in wrangler.jsonc means every deploy, including the first, must carry
# the secrets, so this filters them out of the secrets file into a private temp file and
# passes it with --secrets-file. Values are never printed. Extra args pass through
# (e.g. `npm run deploy -- --dry-run`).
set -euo pipefail

secrets_file="${SATCHEL_SECRETS_FILE:-$HOME/.config/satchel/secrets.env}"
if [ ! -r "$secrets_file" ]; then
  echo "deploy: can't read $secrets_file (set SATCHEL_SECRETS_FILE to override)" >&2
  exit 1
fi

tmp="$(mktemp)"
chmod 600 "$tmp"
trap 'rm -f "$tmp"' EXIT

grep -E '^(NOTION_TOKEN|ANTHROPIC_API_KEY|SATCHEL_KEY)=' "$secrets_file" >"$tmp" || true
for key in NOTION_TOKEN ANTHROPIC_API_KEY SATCHEL_KEY; do
  grep -q "^$key=" "$tmp" || { echo "deploy: $key missing from $secrets_file" >&2; exit 1; }
done

read_id() {
  local value
  value="$(grep -E "^$1=" "$secrets_file" | tail -n 1 | cut -d= -f2- | tr -d "\"' \r")" || true
  if [ -z "$value" ]; then
    echo "deploy: $1 missing from $secrets_file" >&2
    exit 1
  fi
  printf '%s' "$value"
}
database_id="$(read_id NOTION_DATABASE_ID)"
data_source_id="$(read_id NOTION_DATA_SOURCE_ID)"

echo "deploy: secrets file holds keys: $(cut -d= -f1 "$tmp" | tr '\n' ' ')" >&2
cd "$(dirname "$0")/.."
# wrangler lets process env override --secrets-file values, so drop any exported copies.
env -u NOTION_TOKEN -u ANTHROPIC_API_KEY -u SATCHEL_KEY \
  npx wrangler deploy \
  --secrets-file "$tmp" \
  --var "NOTION_DATABASE_ID:$database_id" \
  --var "NOTION_DATA_SOURCE_ID:$data_source_id" \
  "$@"
