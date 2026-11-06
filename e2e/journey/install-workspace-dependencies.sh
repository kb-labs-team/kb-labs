#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
source "$ROOT/e2e/compose-owner.sh"
source "$ROOT/e2e/journey/candidate-services.sh"
journey_compose_init "$ROOT"
trap journey_compose_cleanup EXIT

journey_install_workspace_dependencies
