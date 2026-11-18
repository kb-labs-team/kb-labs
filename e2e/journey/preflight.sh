#!/usr/bin/env bash
# preflight.sh <output-dir> <affected-build-base> owns all shared build, candidate, and journey unit checks.
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
SCRIPT_DIR="$ROOT/e2e/journey"
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

run_stage() {
  stage=$1
  log=$2
  shift 2
  python3 "$SCRIPT_DIR/preflight_stage.py" run --stage "$stage" --log "$log" -- "$@"
}

lockfile_rc=0
run_stage lockfile "$OUT/lockfile.log" bash e2e/scripts/check-frozen-lockfile.sh || lockfile_rc=$?
if [ "$lockfile_rc" -ne 0 ]; then
  failed_stage=lockfile
  echo "journey frozen-lockfile preflight failed; see lockfile.log" >&2
  exit "$lockfile_rc"
fi

stage_started=$(date +%s)
build_rc=0
export ROOT OUT BUILD_BASE work
run_stage build "$OUT/build.log" bash -c '
set -e
(cd "$ROOT/tools/kb-devkit" && go build -trimpath -o "$work/kb-devkit" .) || exit 41
cd "$ROOT"
PATH="$ROOT/tools/kb-devkit:$PATH" \
  REMOTE_STAGE=workspace-build \
  REMOTE_STAGE_RESULT="$OUT/workspace-build-stage.json" \
  REMOTE_RESOURCE_SAMPLES="$OUT/resource-samples.jsonl" \
  REMOTE_STAGE_LOG=/dev/null \
  REMOTE_SELECTED_PACKAGE_COUNT=0 \
  REMOTE_AFFECTED_BUILD=1 \
  REMOTE_DEVKIT_EXECUTABLE="$work/kb-devkit" \
  KB_DEVKIT_BASE_REF="$BUILD_BASE" \
  node scripts/ci/run-remote-stage.mjs || exit 42
if node "$ROOT/e2e/platform/validate-package-outputs.mjs" --build-outputs "$ROOT" > "$OUT/release-build-output-check.log" 2>&1; then
  cat "$OUT/release-build-output-check.log" >> "$OUT/build.log"
else
  cat "$OUT/release-build-output-check.log" >> "$OUT/build.log"
  exit 43
fi
' || build_rc=$?
if [ "$build_rc" -ne 0 ]; then
  build_seconds=$(( $(date +%s) - stage_started ))
  case "$build_rc" in
    *) echo "journey shared build failed; see build.log" >&2 ;;
  esac
  exit 1
fi
build_seconds=$(( $(date +%s) - stage_started ))

failed_stage=candidate
stage_started=$(date +%s)
candidate_rc=0
run_stage candidate "$OUT/candidate.log" bash "$ROOT/e2e/journey/prepare-candidate.sh" || candidate_rc=$?
candidate_seconds=$(( $(date +%s) - stage_started ))
if [ "$candidate_rc" -ne 0 ]; then
  echo "journey candidate preparation failed; see candidate.log" >&2
  exit "$candidate_rc"
fi

failed_stage=unit
unit_home=$(mktemp -d "${TMPDIR:-/tmp}/kb-journey-unit.XXXXXX")
stage_started=$(date +%s)
unit_rc=0
run_stage unit "$OUT/unit.log" env -u KB_PLATFORM_ROOT -u KB_HOME -u KB_NET_OFFSET HOME="$unit_home" python3 -m unittest discover -s e2e/journey -p 'test_*.py' || unit_rc=$?
unit_seconds=$(( $(date +%s) - stage_started ))
if [ "$unit_rc" -ne 0 ]; then
  echo "journey unit suite failed; see unit.log" >&2
  exit "$unit_rc"
fi
failed_stage=none
