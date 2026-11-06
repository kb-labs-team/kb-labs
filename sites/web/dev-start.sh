#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "Error: pnpm is not installed or not available in PATH."
  exit 1
fi

if [[ ! -d node_modules ]]; then
  echo "Installing dependencies (first run)..."
  pnpm install
fi

echo "Starting KB Labs web dev infrastructure:"
echo "  - web  (kblabs.dev):      http://localhost:3000"
echo "  - docs (docs.kblabs.dev): http://localhost:3001"
echo "  - app  (app.kblabs.dev):  http://localhost:3002"
echo
echo "Press Ctrl+C to stop all services."

pnpm dev:all
