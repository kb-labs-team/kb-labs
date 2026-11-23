#!/usr/bin/env bash
set -euo pipefail

workspace_root=${1:?usage: resolve-shared-root.sh <workspace-root> <github-output>}
github_output=${2:?usage: resolve-shared-root.sh <workspace-root> <github-output>}
workspace_root=$(cd "$workspace_root" && pwd -P)
checkout_sha=$(git -C "$workspace_root" rev-parse HEAD)

top_level=$(git -C "$workspace_root" rev-parse --show-toplevel)
top_level=$(cd "$top_level" && pwd -P)
if [[ "$top_level" != "$workspace_root" ]]; then
  # Match cache.SharedRoot for a workspace nested inside another repository.
  store_path="$workspace_root/.kb/devkit/shared"
else
  common_dir=$(git -C "$workspace_root" rev-parse --git-common-dir)
  if [[ "$common_dir" != /* ]]; then
    common_dir="$workspace_root/$common_dir"
  fi
  common_dir=$(cd "$common_dir" && pwd -P)
  store_path="$common_dir/kb-devkit"
fi

mkdir -p "$store_path"
printf 'path=%s\n' "$store_path" >> "$github_output"
printf 'sha=%s\n' "$checkout_sha" >> "$github_output"
