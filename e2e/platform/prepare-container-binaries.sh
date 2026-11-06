#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
output="$root/.journey/e2e-platform-binaries"
mkdir -p "$output"
version="$(node -p 'require("./core/runtime/package.json").version')"
bash scripts/prepare-candidate-binaries.sh build "$version" \
  --artifacts dist/artifacts.json --checksums dist/checksums.txt \
  --repository kb-labs-team/kb-labs --release-tag journey-candidate \
  --version "$version" --asset-base-url http://origin:8080/journey-candidate \
  --output "$output/binary-manifest.json"
node e2e/platform/stage-release-binaries.mjs dist/artifacts.json "$output"
(cd tools/kb-create && CGO_ENABLED=0 go build -trimpath -o "$output/kb-create-release-index" ./v2/cmd/kb-create-release-index)
