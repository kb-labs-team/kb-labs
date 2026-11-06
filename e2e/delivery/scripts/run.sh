#!/usr/bin/env bash
set -euo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
delivery_directory="$(cd -- "$script_directory/.." && pwd)"
repository_root="$(cd -- "$delivery_directory/../.." && pwd)"
policy_cli="$repository_root/core/plugin-runtime/src/platform-resolve/node-engine.mjs"
source "$repository_root/e2e/compose-owner.sh"
node_major="$(node "$policy_cli" --required-major "$repository_root/package.json")"
export KB_NODE_MAJOR="$node_major"
compose_owner_init
KB_DELIVERY_COMPOSE_COMMAND="$(compose_owner_json)"
export KB_DELIVERY_COMPOSE_COMMAND

mode="${1:-run}"
if [[ "$#" -gt 0 ]]; then
  shift
fi

cd "$delivery_directory"
if [[ "$mode" == "config" ]]; then
  exec "${COMPOSE_OWNER_COMMAND[@]}" -f "$delivery_directory/docker-compose.yml" config "$@"
fi
if [[ "$mode" != "run" ]]; then
  printf 'Usage: %s [run|config] [arguments...]\n' "${0##*/}" >&2
  exit 2
fi

exec env DELIVERY_E2E=1 KB_NODE_MAJOR="$node_major" go test -v -timeout 10m "$@"
