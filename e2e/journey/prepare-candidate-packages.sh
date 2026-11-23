#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$1" && pwd)"
PACKAGES="$2"
CACHE_READY="${3:-0}"
VALIDATOR="$ROOT/e2e/platform/validate-package-outputs.mjs"

if [[ "$CACHE_READY" == "1" ]]; then
  validation_log="$(mktemp)"
  trap 'rm -f "$validation_log"' EXIT
  if node "$VALIDATOR" "$PACKAGES" "$ROOT" >"$validation_log" 2>&1; then
    cat "$validation_log"
    exit 0
  fi
  echo "Restored candidate package cache does not match this workspace; discarding it and repacking." >&2
  sed 's/^/  cached validation: /' "$validation_log" >&2
else
  echo "No validated candidate package cache was restored; packing from this workspace."
fi

rm -f "$PACKAGES"/*.tgz
bash "$ROOT/e2e/scripts/pack-all.sh" "$PACKAGES"
node "$VALIDATOR" "$PACKAGES" "$ROOT"
