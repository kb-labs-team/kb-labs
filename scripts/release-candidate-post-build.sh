#!/usr/bin/env bash
set -euo pipefail

required() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    printf 'Missing required release candidate input: %s\n' "$name" >&2
    exit 2
  fi
}

for name in CANDIDATE_ID COMMIT_SHA FLOW CHANNEL SOURCE_REVISION GATE_POLICY GATE_RESULT RUN_ID ARTIFACTS_DIR BUNDLE_DIR RELEASE_INDEX_PATH BINARY_MANIFEST_PATH BINARIES_DIR PROVENANCE_MANIFEST_PATH; do
  required "$name"
done
if [[ "${RELEASE_PREFLIGHT_COVERAGE:-}" != shared ]]; then
  printf 'RELEASE_PREFLIGHT_COVERAGE must be shared when invoking candidate post-build.\n' >&2
  exit 2
fi

mkdir -p "$(dirname "$PROVENANCE_MANIFEST_PATH")" "$(dirname "$RELEASE_INDEX_PATH")"
packages_dir="$(cd "$ARTIFACTS_DIR" && pwd -P)"
go -C tools/kb-create run ./v2/cmd/kb-create-release-index provenance \
  "$packages_dir" "$SOURCE_REVISION" \
  < "$ARTIFACTS_DIR/manifest.json" > "$PROVENANCE_MANIFEST_PATH"

config_json="$(node --input-type=module -e '
  import { readPlatformReleaseConfig } from "./tools/kb-create/scripts/platform-release-config.mjs";
  process.stdout.write(JSON.stringify(readPlatformReleaseConfig("./.kb/kb.config.jsonc")));
')"
platform_members="$(node -e 'const d=JSON.parse(require("node:fs").readFileSync(0,"utf8")); process.stdout.write(d.platformMembers.join(","));' <<< "$config_json")"
platform_requires="$(node -e 'const d=JSON.parse(require("node:fs").readFileSync(0,"utf8")); process.stdout.write(d.platformRequires.join(","));' <<< "$config_json")"
platform_adapters="$(node -e 'const d=JSON.parse(require("node:fs").readFileSync(0,"utf8")); process.stdout.write(JSON.stringify(d.adapters));' <<< "$config_json")"
platform_adapter_options="$(node -e 'const d=JSON.parse(require("node:fs").readFileSync(0,"utf8")); process.stdout.write(JSON.stringify(d.adapterOptions));' <<< "$config_json")"

node tools/kb-create/scripts/prepare-release-index.mjs \
  --flow "$FLOW" \
  --channel "$CHANNEL" \
  --artifacts-dir "$ARTIFACTS_DIR" \
  --provenance-manifest "$PROVENANCE_MANIFEST_PATH" \
  --binary-manifest "$BINARY_MANIFEST_PATH" \
  --platform-member-packages "$platform_members" \
  --platform-requires "$platform_requires" \
  --platform-adapter-config "$platform_adapters" \
  --platform-adapter-options "$platform_adapter_options" \
  --output "$RELEASE_INDEX_PATH"

version="$(node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const index = JSON.parse(readFileSync(process.env.RELEASE_INDEX_PATH, "utf8"));
  const platform = (index.platforms ?? []).find(artifact => artifact.id === "platform");
  if (!platform) throw new Error("sealed release index has no platform artifact");
  process.stdout.write(platform.version);
')"
if [[ -n "${EXPECTED_VERSION:-}" && "$version" != "$EXPECTED_VERSION" ]]; then
  printf 'Sealed platform version mismatch: %s != %s\n' "$version" "$EXPECTED_VERSION" >&2
  exit 1
fi

export VERSION="$version"
export ARTIFACTS_DIR BUNDLE_DIR RELEASE_INDEX_PATH BINARY_MANIFEST_PATH BINARIES_DIR
export CANDIDATE_ID COMMIT_SHA FLOW CHANNEL GATE_POLICY GATE_RESULT RUN_ID
node plugins/release/scripts/create-candidate-bundle.mjs
