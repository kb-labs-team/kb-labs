#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENGINE="buildx"
BUILD_ARGS=()

if [[ -n "${PUBLISHER_BUILD_ENGINE:-}" ]]; then ENGINE="$PUBLISHER_BUILD_ENGINE"; fi
if [[ -n "${PUBLISHER_BUILD_CACHE_FROM:-}" ]]; then BUILD_ARGS+=(--cache-from "$PUBLISHER_BUILD_CACHE_FROM"); fi
if [[ -n "${PUBLISHER_BUILD_CACHE_TO:-}" ]]; then BUILD_ARGS+=(--cache-to "$PUBLISHER_BUILD_CACHE_TO"); fi

while (($#)); do
  case "$1" in
    --engine)
      ENGINE="$2"
      shift 2
      ;;
    --cache-from|--cache-to)
      BUILD_ARGS+=("$1" "$2")
      shift 2
      ;;
    *)
      printf 'Unknown publisher build option: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done

case "$ENGINE" in
  buildx)
    BUILD_ARGS+=(--load -t kb-e2e-ci-publisher:latest -f e2e/publisher/Dockerfile "$ROOT")
    docker buildx build "${BUILD_ARGS[@]}"
    ;;
  docker)
    if ((${#BUILD_ARGS[@]})); then
      printf 'Docker engine does not support publisher cache options.\n' >&2
      exit 2
    fi
    docker build -t kb-e2e-ci-publisher:latest \
      -f e2e/publisher/Dockerfile "$ROOT"
    ;;
  *)
    printf 'Unsupported publisher build engine: %s\n' "$ENGINE" >&2
    exit 2
    ;;
esac
