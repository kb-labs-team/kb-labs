#!/usr/bin/env bash
# preflight.sh <output-dir> <affected-build-base> owns all shared build, candidate, and journey unit checks.
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
OUT=${1:?usage: e2e/journey/preflight.sh <output-dir> <affected-build-base>}
BUILD_BASE=${2:?usage: e2e/journey/preflight.sh <output-dir> <affected-build-base>}
case "$OUT" in /*) ;; *) OUT="$ROOT/$OUT" ;; esac
mkdir -p "$OUT"
work=$(mktemp -d "${TMPDIR:-/tmp}/kb-journey-preflight.XXXXXX")
unit_home=""
build_seconds=0
candidate_seconds=0
unit_seconds=0
failed_stage=build
started=$(date +%s)

cleanup() {
  result=$?
  cleanup_rc=0
  trap - EXIT HUP INT TERM
  if [ -n "$unit_home" ] && [ -d "$unit_home" ]; then
    if ! chmod -R u+w "$unit_home" 2>/dev/null; then
      echo "could not make isolated journey-test HOME writable for cleanup: $unit_home" >&2
    fi
    if ! rm -rf "$unit_home"; then
      echo "could not remove isolated journey-test HOME $unit_home" >&2
      cleanup_rc=1
    fi
  fi
  if ! chmod -R u+w "$work" 2>/dev/null; then
    echo "could not make journey preflight build directory writable for cleanup: $work" >&2
  fi
  if ! rm -rf "$work"; then
    echo "could not remove journey preflight build directory $work" >&2
    cleanup_rc=1
  fi
  printf 'build=%s\ncandidate=%s\nunit=%s\ntotal=%s\nfailed_stage=%s\n' "$build_seconds" "$candidate_seconds" "$unit_seconds" "$(( $(date +%s) - started ))" "$failed_stage" > "$OUT/stage-durations.env"
  if [ "$result" -eq 0 ] && [ "$cleanup_rc" -ne 0 ]; then result=1; fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
cd "$ROOT"

bash e2e/scripts/check-frozen-lockfile.sh

stage_started=$(date +%s)
if ! (cd tools/kb-devkit && go build -trimpath -o "$work/kb-devkit" .) > "$OUT/build.log" 2>&1; then
  build_seconds=$(( $(date +%s) - stage_started ))
  echo "could not build kb-devkit from this checkout; see $OUT/build.log; next: (cd tools/kb-devkit && go build .)" >&2
  exit 1
fi
if ! (
  cd "$ROOT"
  PATH="$ROOT/tools/kb-devkit:$PATH" \
    REMOTE_STAGE=workspace-build \
    REMOTE_STAGE_RESULT="$OUT/workspace-build-stage.json" \
    REMOTE_RESOURCE_SAMPLES="$OUT/resource-samples.jsonl" \
    REMOTE_SELECTED_PACKAGE_COUNT=0 \
    REMOTE_AFFECTED_BUILD=1 \
    REMOTE_DEVKIT_EXECUTABLE="$work/kb-devkit" \
    KB_DEVKIT_BASE_REF="$BUILD_BASE" \
    node scripts/ci/run-remote-stage.mjs
) 2>&1 | tee -a "$OUT/build.log"; then
  build_seconds=$(( $(date +%s) - stage_started ))
  echo "devkit affected build failed; see $OUT/build.log; next: KB_DEVKIT_BASE_REF='$BUILD_BASE' REMOTE_STAGE=workspace-build REMOTE_STAGE_RESULT='$OUT/workspace-build-stage.json' REMOTE_RESOURCE_SAMPLES='$OUT/resource-samples.jsonl' REMOTE_SELECTED_PACKAGE_COUNT=0 REMOTE_AFFECTED_BUILD=1 REMOTE_DEVKIT_EXECUTABLE='$work/kb-devkit' node scripts/ci/run-remote-stage.mjs" >&2
  exit 1
fi
output_check_rc=0
node "$ROOT/e2e/platform/validate-package-outputs.mjs" --build-outputs "$ROOT" > "$OUT/release-build-output-check.log" 2>&1 || output_check_rc=$?
cat "$OUT/release-build-output-check.log" >> "$OUT/build.log"
if [ "$output_check_rc" -ne 0 ]; then
  build_seconds=$(( $(date +%s) - stage_started ))
  cat "$OUT/release-build-output-check.log" >&2
  echo "release package build outputs are missing; see $OUT/build.log; next: kb-devkit run build --affected" >&2
  exit 1
fi
build_seconds=$(( $(date +%s) - stage_started ))

failed_stage=candidate
stage_started=$(date +%s)
candidate_rc=0
bash "$ROOT/e2e/journey/prepare-candidate.sh" > "$OUT/candidate.log" 2>&1 || candidate_rc=$?
candidate_seconds=$(( $(date +%s) - stage_started ))
if [ "$candidate_rc" -ne 0 ]; then
  echo "journey candidate preparation failed; see $OUT/candidate.log; next: e2e/journey/prepare-candidate.sh" >&2
  exit "$candidate_rc"
fi

failed_stage=unit
unit_home=$(mktemp -d "${TMPDIR:-/tmp}/kb-journey-unit.XXXXXX")
stage_started=$(date +%s)
unit_rc=0
HOME="$unit_home" env -u KB_PLATFORM_ROOT -u KB_HOME -u KB_NET_OFFSET python3 -m unittest discover -s e2e/journey -p 'test_*.py' > "$OUT/unit.log" 2>&1 || unit_rc=$?
unit_seconds=$(( $(date +%s) - stage_started ))
if [ "$unit_rc" -ne 0 ]; then
  echo "journey unit suite failed; see $OUT/unit.log; next: python3 -m unittest discover -s e2e/journey -p 'test_*.py'" >&2
  exit "$unit_rc"
fi
failed_stage=none
