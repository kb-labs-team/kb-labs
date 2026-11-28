#!/bin/sh
# Runs inside the disposable E2E platform container.
set -eu
platform_root=${KB_E2E_PLATFORM_ROOT:-/workspace/kb-e2e}
state_dir=${KB_E2E_PRESSURE_STATE:-/tmp/kb-e2e-gateway-pressure}
overlay=${KB_E2E_PRESSURE_OVERLAY:-/workspace/e2e-host/gateway/scenarios/pressure/overlay.jsonc}

restore() {
  [ -d "$state_dir" ] || return 0
  config_file=$(cat "$state_dir/path")
  if [ -e "$state_dir/existed" ]; then
    cp -p "$state_dir/config" "$config_file"
  else
    rm -f "$config_file"
  fi
  kb-create restart --platform-root "$platform_root"
  rm -f "$state_dir/config" "$state_dir/existed" "$state_dir/path"
  rmdir "$state_dir"
}

case "${1:-}" in
  default) restore ;;
  pressure)
    [ ! -e "$state_dir" ] || { echo 'pressure fixture is already applied' >&2; exit 1; }
    config_result=$(kb config get --scope platform gateway.pressure --json)
    config_file=$(printf '%s' "$config_result" | jq -er 'select(.ok == true) | .data.source | select(type == "string" and startswith("/"))')
    pressure=$(sed '/^[[:space:]]*\/\//d' "$overlay" | jq -ce '.gateway.pressure')
    umask 077
    mkdir "$state_dir"
    printf '%s' "$config_file" > "$state_dir/path"
    if [ -f "$config_file" ]; then
      cp -p "$config_file" "$state_dir/config"
      : > "$state_dir/existed"
    fi
    if ! kb config set --scope platform gateway.pressure "$pressure" --json ||
       ! kb-create restart --platform-root "$platform_root"; then
      restore || true
      exit 1
    fi
    ;;
  *) echo 'unknown installed gateway scenario' >&2; exit 2 ;;
esac
