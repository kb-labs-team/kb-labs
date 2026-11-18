#!/usr/bin/env bash
set -euo pipefail

expected="${1:?expected pnpm version is required}"
current="$(pnpm --version 2>/dev/null | head -1 || true)"

if [ "$current" != "$expected" ]; then
  echo "pnpm ${current:-missing} found; activating pnpm@$expected"
  if command -v corepack >/dev/null; then
    sudo corepack enable pnpm 2>/dev/null || corepack enable pnpm 2>/dev/null || true
    corepack prepare "pnpm@$expected" --activate 2>/dev/null || true
    current="$(pnpm --version 2>/dev/null | head -1 || true)"
  fi
  if [ "$current" != "$expected" ]; then
    sudo npm install -g "pnpm@$expected" 2>/dev/null \
      || { echo "::error::failed to install pnpm@$expected on host" >&2; exit 1; }
    current="$(pnpm --version 2>/dev/null | head -1 || true)"
  fi
fi

if [ "$current" != "$expected" ]; then
  echo "::error::host pnpm $current does not match workspace pin $expected" >&2
  exit 1
fi

echo "pnpm: $current"
