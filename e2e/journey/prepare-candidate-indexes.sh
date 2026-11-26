#!/usr/bin/env bash

journey_prepare_candidate_indexes() {
  local root="$1"
  local packages="$2"
  local output="$3"
  local target="$4"
  local binary_version="$5"
  local commit="$6"
  local -a args=(
    --packages-dir "$packages"
    --registry-manifest "$root/e2e/platform/registry-manifest.json"
    --sealer "$output/kb-create-release-index"
    --binary-dir "$target"
    --binary-manifest "$target/binary-manifest.json"
    --release-config "$root/tools/kb-create/config/platform-release.jsonc"
    --binary-version "$binary_version"
    --source-revision "$commit"
    --prepare-script "$root/tools/kb-create/scripts/prepare-release-index.mjs"
    --output "$target/release-index.json"
  )
  if [[ -s "$target/binary-manifest-map.json" ]]; then
    args+=(--binary-manifest-map "$target/binary-manifest-map.json")
  fi
  node "$root/e2e/platform/prepare-release-index.mjs" "${args[@]}"
}
