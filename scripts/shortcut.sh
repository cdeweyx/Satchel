#!/usr/bin/env bash
# Builds the signed iOS Shortcut (D-7): generate the unsigned template, check its shape,
# sign it to dist/Satchel.shortcut (gitignored), then check the signed file starts with
# `AEA1` and that shortcut/ holds no secret. Signing needs network. If it fails, this
# prints the manual build steps from shortcut/README.md and exits non-zero.
set -euo pipefail

cd "$(dirname "$0")/.."

template="shortcut/Satchel.unsigned.shortcut"
out="dist/Satchel.shortcut"

manual_steps() {
  echo >&2
  echo "shortcut: build it by hand on the iPhone instead (from shortcut/README.md):" >&2
  awk '/^## Manual build/ { on = 1; next } on && /^## / { exit } on' shortcut/README.md >&2
}

python3 -I shortcut/build-shortcut.py
python3 -I shortcut/assert-template.py

mkdir -p dist
rm -f "$out"
if ! shortcuts sign --mode anyone -i "$template" -o "$out"; then
  echo "shortcut: shortcuts sign failed (it needs network and macOS Shortcuts)" >&2
  manual_steps
  exit 1
fi

header="$(head -c4 "$out" 2>/dev/null || true)"
if [ "$header" != "AEA1" ]; then
  echo "shortcut: $out doesn't start with AEA1 (got '${header}'), so it isn't a signed Shortcut" >&2
  manual_steps
  exit 1
fi
echo "shortcut: $out starts with AEA1"

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "shortcut: gitleaks not found; install it (brew install gitleaks) and run again" >&2
  exit 1
fi
gitleaks detect --no-git --source shortcut --config .gitleaks.toml --redact --no-banner
echo "shortcut: gitleaks found no secrets in shortcut/"

echo "shortcut: signed $out. AirDrop it to your iPhone and see shortcut/README.md to install."
