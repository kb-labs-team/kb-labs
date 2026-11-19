#!/usr/bin/env bash
set -euo pipefail
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$ROOT"

# Registry journeys build the same local service images as the profile does.
# These two pnpm deploy trees are local build inputs only; no image is pushed.
pnpm deploy --filter @kb-labs/core-state-daemon --prod .kb/deploy/state-daemon
pnpm deploy --filter @kb-labs/marketplace-registry-app --prod .kb/deploy/marketplace-registry-app
node tools/release/generate-platform-image-default.mjs

for required in \
  .kb/deploy/state-daemon/node_modules \
  .kb/deploy/state-daemon/dist \
  .kb/deploy/marketplace-registry-app/node_modules \
  .kb/deploy/marketplace-registry-app/dist \
  .kb/deploy/image-default/kb.config.json; do
  if [ ! -e "$required" ]; then
    echo "Registry journey deploy preparation did not produce $required" >&2
    exit 1
  fi
done
