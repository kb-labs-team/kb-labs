#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

mode="${1:-all}"
prepare_deploy() {
  pnpm --filter "$1" --prod deploy "$2"
}

case "$mode" in
  all)
    prepare_deploy @kb-labs/core-state-daemon .kb/deploy/state-daemon
    prepare_deploy @kb-labs/gateway-app .kb/deploy/gateway-app
    prepare_deploy @kb-labs/marketplace-app .kb/deploy/marketplace-app
    prepare_deploy @kb-labs/rest-api-app .kb/deploy/rest-api-app
    prepare_deploy @kb-labs/studio-app .kb/deploy/studio-app
    prepare_deploy @kb-labs/workflow-daemon .kb/deploy/workflow-daemon
    prepare_deploy @kb-labs/mcp-app .kb/deploy/mcp-app
    prepare_deploy @kb-labs/marketplace-registry-app .kb/deploy/marketplace-registry-app
    ;;
  registry-journey)
    prepare_deploy @kb-labs/core-state-daemon .kb/deploy/state-daemon
    prepare_deploy @kb-labs/marketplace-registry-app .kb/deploy/marketplace-registry-app
    ;;
  *)
    echo "Usage: $0 [all|registry-journey]" >&2
    exit 2
    ;;
esac

node tools/release/generate-platform-image-default.mjs
