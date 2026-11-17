#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
DEPLOY_ROOT="${KB_JOURNEY_DEPLOY_ROOT:-.journey/deploy/manual}"

# Keep the Docker build inputs aligned with the platform image release workflow.
# pnpm 11's injected deploy resolves workspace packages from the current build;
# --legacy resolves them through the public registry and can select stale versions.
pnpm --config.inject-workspace-packages=true deploy \
  --filter @kb-labs/core-state-daemon --prod "$DEPLOY_ROOT/state-daemon"
pnpm --config.inject-workspace-packages=true deploy \
  --filter @kb-labs/marketplace-registry-app --prod "$DEPLOY_ROOT/marketplace-registry-app"
node tools/release/generate-platform-image-default.mjs "$DEPLOY_ROOT/image-default/kb.config.json"
