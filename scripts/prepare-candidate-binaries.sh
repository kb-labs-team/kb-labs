#!/usr/bin/env bash
set -euo pipefail
mode="$1"
shift
if [[ "$mode" == build ]]; then
  version="$1"
  shift
  if [[ -n "${KBLABS_RELEASE_GORELEASER_CONFIG:-}" ]]; then
    GORELEASER_CURRENT_TAG="v${version}-binaries" goreleaser release --config "$KBLABS_RELEASE_GORELEASER_CONFIG" --snapshot --clean --skip=publish
  else
    GORELEASER_CURRENT_TAG="v${version}-binaries" goreleaser release --snapshot --clean --skip=publish
  fi
  if ! git diff --exit-code -- '**/go.mod' '**/go.sum'; then
    echo 'GoReleaser before hooks changed Go module files; restore and reconcile them before releasing.' >&2
    exit 1
  fi
elif [[ "$mode" != manifest ]]; then
  echo 'Usage: prepare-candidate-binaries.sh build VERSION MANIFEST_ARGS... | manifest MANIFEST_ARGS...' >&2
  exit 2
fi
exec node tools/kb-create/scripts/prepare-binary-manifest.mjs "$@"
