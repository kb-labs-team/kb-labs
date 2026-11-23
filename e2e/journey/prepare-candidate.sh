#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
source "$ROOT/e2e/compose-owner.sh"
source "$ROOT/e2e/journey/candidate-services.sh"
source "$ROOT/e2e/journey/phase-timing.sh"
journey_compose_init "$ROOT"
trap journey_compose_cleanup EXIT
OUT="$ROOT/.journey"
PACKAGES="$ROOT/e2e/packages"
TAG="journey-candidate"
TARGET="$OUT/release/$TAG"
COMMIT="$(git -C "$ROOT" rev-parse --short HEAD)"

journey_phase_start "check-frozen-lockfile"
(
  cd "$ROOT"
  bash "$ROOT/e2e/scripts/check-frozen-lockfile.sh"
)
journey_phase_end

journey_phase_start "build-pack-extras"
node "$ROOT/e2e/scripts/build-pack-extras.mjs" "$ROOT"
journey_phase_end

journey_phase_start "validate-workspace-package-outputs"
node "$ROOT/e2e/platform/validate-package-outputs.mjs" --build-outputs "$ROOT"
journey_phase_end

journey_phase_start "stage-runner-inputs"
bash "$ROOT/e2e/journey/stage-runner-inputs.sh"
journey_phase_end

mkdir -p "$PACKAGES" "$TARGET"
journey_phase_start "stage-release-package-manifest"
node "$ROOT/e2e/platform/release-index-package-stage.mjs" --packages-dir "$PACKAGES" --output-dir "$TARGET"
journey_phase_end
rm -rf "$TARGET"
mkdir -p "$TARGET"
journey_phase_start "prepare-candidate-packages"
if [[ "${KB_JOURNEY_PACKAGES_READY:-0}" == "1" ]]; then
  echo "Package cache: candidate tarballs restored; validating before reuse."
else
  echo "Package cache: no candidate tarballs restored; repacking."
fi
"$ROOT/e2e/journey/prepare-candidate-packages.sh" "$ROOT" "$PACKAGES" "${KB_JOURNEY_PACKAGES_READY:-0}"
journey_phase_end

# The sealer is a host tool; distributable binaries come from GoReleaser.
journey_phase_start "build-release-index-sealer"
(cd "$ROOT/tools/kb-create" && CGO_ENABLED=0 go build -trimpath -ldflags '-s -w' -o "$OUT/kb-create-release-index" ./v2/cmd/kb-create-release-index)
journey_phase_end
BINARY_VERSION="$(node -p "require('$ROOT/core/runtime/package.json').version")"
journey_phase_start "prepare-candidate-binary-manifest"
bash "$ROOT/scripts/prepare-candidate-binaries.sh" build "$BINARY_VERSION" \
  --artifacts "$ROOT/dist/artifacts.json" \
  --checksums "$ROOT/dist/checksums.txt" \
  --repository kb-labs-team/kb-labs \
  --release-tag "$TAG" \
  --version "$BINARY_VERSION" \
  --asset-base-url "${KB_JOURNEY_BINARY_BASE_URL:-http://origin:8080/journey-candidate}" \
  --output "$TARGET/binary-manifest.json"
journey_phase_end
journey_phase_start "stage-candidate-binaries"
node "$ROOT/e2e/platform/stage-release-binaries.mjs" "$ROOT/dist/artifacts.json" "$TARGET"
BINARY_FILES=()
while IFS= read -r filename; do BINARY_FILES+=("$filename"); done < <(node -e 'const fs=require("fs"); for (const b of JSON.parse(fs.readFileSync(process.argv[1])).binaries) console.log(b.filename)' "$TARGET/binary-manifest.json")
journey_phase_end

journey_phase_start "prepare-and-seal-release-indexes"
node "$ROOT/e2e/platform/prepare-release-index.mjs" \
  --packages-dir "$PACKAGES" \
  --registry-manifest "$ROOT/e2e/platform/registry-manifest.json" \
  --sealer "$OUT/kb-create-release-index" \
  --binary-dir "$TARGET" \
  --binary-manifest "$TARGET/binary-manifest.json" \
  --binary-manifest-tool "$ROOT/scripts/prepare-candidate-binaries.sh" \
  --binary-artifacts "$ROOT/dist/artifacts.json" \
  --binary-checksums "$ROOT/dist/checksums.txt" \
  --release-config "$ROOT/tools/kb-create/config/platform-release.jsonc" \
  --binary-version "$BINARY_VERSION" \
  --source-revision "$COMMIT" \
  --prepare-script "$ROOT/tools/kb-create/scripts/prepare-release-index.mjs" \
  --output "$TARGET/release-index.json"
journey_phase_end

# Install the real candidate graph through kb-create's staging and package
# installer, then run the same built-entrypoint checker used by S-054.16.
RUNTIME_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/kb-candidate-runtime-root.XXXXXX")"
cleanup() {
  local status=$?
  trap - EXIT
  if ! rm -rf "$RUNTIME_ROOT"; then
    echo "Could not remove candidate runtime temp root $RUNTIME_ROOT." >&2
    (( status != 0 )) || status=1
  fi
  if ! journey_compose_cleanup; then
    echo "Could not remove journey Compose overlay temp state." >&2
    status=1
  fi
  exit "$status"
}
trap cleanup EXIT
journey_phase_start "install-candidate-runtime"
RUNTIME_CONTENT_ROOT="$(journey_install_candidate_runtime "$TARGET/release-index.json" "$PACKAGES" "$RUNTIME_ROOT")"
journey_phase_end
journey_phase_start "verify-sdk-runtime-imports"
node "$ROOT/e2e/journey/sdk_runtime_import_check.mjs" "$RUNTIME_CONTENT_ROOT"
journey_phase_end

journey_phase_start "write-candidate-checksums"
(
  cd "$TARGET"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "${BINARY_FILES[@]}" release-index.json release-index-update.json release-index-update-jump.json release-index-update-minor.json release-index-update-failed-host.json release-index-update-healthy-host.json release-index-update-bad-checksum.json release-index-update-config-failure.json release-index-update-doctor-failure.json release-index-canary.json > checksums.txt
  else
    shasum -a 256 "${BINARY_FILES[@]}" release-index.json release-index-update.json release-index-update-jump.json release-index-update-minor.json release-index-update-failed-host.json release-index-update-healthy-host.json release-index-update-bad-checksum.json release-index-update-config-failure.json release-index-update-doctor-failure.json release-index-canary.json > checksums.txt
  fi
)
journey_phase_end
echo "Prepared $TARGET"
