#!/usr/bin/env bash
set -euo pipefail

version="$(pnpm --version)"
case "$version" in
  11.*)
    args=("$@")
    if [ "${#args[@]}" -gt 0 ]; then
      destination="${args[${#args[@]}-1]}"
      args=("${args[@]:0:${#args[@]}-1}" --legacy "$destination")
    else
      args=(--legacy)
    fi
    exec pnpm deploy "${args[@]}"
    ;;
  12.*) exec pnpm deploy "$@" ;;
  *) echo "::error::unsupported pnpm version for deploy: $version" >&2; exit 1 ;;
esac
