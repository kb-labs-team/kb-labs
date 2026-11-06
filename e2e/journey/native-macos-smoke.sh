#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
source "$ROOT/e2e/compose-owner.sh"
source "$ROOT/e2e/journey/candidate-services.sh"
journey_compose_init "$ROOT"

native_root="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/native-installer-smoke.XXXXXX")"
export HOME="$native_root/home"
mkdir -p "$HOME"
unset KB_PLATFORM_ROOT KB_HOME KB_NET_OFFSET
export NPM_CONFIG_USERCONFIG="$HOME/.npmrc"
export KB_JOURNEY_NATIVE_ROOT="$native_root"

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if ! journey_stop_host_services; then
    (( status != 0 )) || status=1
  fi
  journey_compose_cleanup
  rm -rf "$native_root"
  exit "$status"
}
trap cleanup EXIT INT TERM

journey_start_host_services
export NPM_CONFIG_REGISTRY="$JOURNEY_REGISTRY_HOST_URL"
export KB_JOURNEY_REGISTRY_URL="$JOURNEY_REGISTRY_HOST_URL"
node e2e/journey/native-macos-install.mjs
