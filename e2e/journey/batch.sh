#!/bin/sh
# batch.sh owns the shared producer and per-mode journey stages.
set -u
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
BUILD_BASE=${KB_DEVKIT_BASE_REF:-local/main...HEAD}
BASELINE=${BATCH_BASELINE:-j28}
SCRIPT_DIR="$ROOT/e2e/journey"

usage() {
  echo "usage: batch.sh prepare <output-dir> [baseline] | mode <local|secured> <producer-artifact> <output-dir> [--cases <case-ids>] | summarize <output-dir> <producer-artifact> <local-artifact> <secured-artifact> | <output-dir> [baseline]" >&2
  exit 2
}
absolute() { case "$1" in /*) printf '%s\n' "$1" ;; *) printf '%s/%s\n' "$ROOT" "$1" ;; esac; }
declare_artifacts() {
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf 'artifact_shared=%s/shared\nartifact_local=%s/local\nartifact_secured=%s/secured\n' "$1" "$1" "$1" >> "$GITHUB_OUTPUT"
  fi
}
write_metadata() {
  metadata_path=$1 metadata_mode=$2 metadata_result=$3 metadata_commit=$4 metadata_baseline=$5 metadata_build=$6
  "${BATCH_PYTHON:-python3}" "$SCRIPT_DIR/batch_summary.py" metadata \
    "$metadata_path" "$metadata_mode" "$metadata_result" "$metadata_commit" "$metadata_baseline" "$metadata_build" \
    "${reset_seconds:-0}" "${build_seconds:-0}" "${unit_seconds:-0}" "${candidate_seconds:-0}" \
    "${local_seconds:-0}" "${secured_seconds:-0}" "${total_seconds:-0}" \
    "$(absolute "${metadata_path%/batch-metadata.json}/build-candidate.tar")"
}
run_prepare() {
  out=$(absolute "$1")
  BASELINE=${2:-$BASELINE}
  shared="$out/shared"
  mkdir -p "$shared"
  : > "$shared/build.log"
  declare_artifacts "$out"
  cd "$ROOT"
  commit=$(git rev-parse HEAD)
  "${BATCH_PYTHON:-python3}" "$SCRIPT_DIR/batch_summary.py" run \
    "$shared/run.json" "$commit" "$BASELINE" "$BUILD_BASE"
  printf '# Journey batch\n\n- Commit: `%s`\n- Baseline: `%s`\n- Build base: `%s`\n' "$commit" "$BASELINE" "$BUILD_BASE" > "$shared/summary.md"
  validate_ref() {
    if ! git rev-parse --verify --quiet "$1^{commit}" >/dev/null 2>&1; then
      printf '\n- Failed stage: `build`\n- Stage log: `build.log`\n- Result: FAIL\n' >> "$shared/summary.md"
      echo "affected-build base ref '$1' is missing from this checkout; next: git fetch --all --prune" >&2
      reset_seconds=0; build_seconds=0; unit_seconds=0; candidate_seconds=0; local_seconds=0; secured_seconds=0; total_seconds=0
      write_metadata "$shared/batch-metadata.json" shared FAIL "$commit" "$BASELINE" "$BUILD_BASE"
      return 1
    fi
  }
  case "$BUILD_BASE" in
    *...*) validate_ref "${BUILD_BASE%%...*}" || return 1; validate_ref "${BUILD_BASE#*...}" || return 1 ;;
    *) validate_ref "$BUILD_BASE" || return 1 ;;
  esac
  batch_started=$(date +%s)
  prepare_interrupted=0
  prepare_finalized=0
  prepare_finalize() {
    status=$?
    [ "$prepare_finalized" -eq 0 ] || return "$status"
    prepare_finalized=1
    [ "$status" -eq 0 ] || [ "$prepare_interrupted" -eq 1 ] || return "$status"
    [ "$prepare_interrupted" -eq 1 ] && final_result=INTERRUPTED || final_result=FAIL
    total_seconds=$(($(date +%s) - batch_started))
    printf '\n- Result: %s\n' "$final_result" >> "$shared/summary.md"
    write_metadata "$shared/batch-metadata.json" shared "$final_result" "$commit" "$BASELINE" "$BUILD_BASE"
    return "$status"
  }
  trap prepare_finalize EXIT
  trap 'prepare_interrupted=1; exit 129' HUP
  trap 'prepare_interrupted=1; exit 130' INT
  trap 'prepare_interrupted=1; exit 143' TERM
  reset_started=$(date +%s)
  reset_rc=0
  "$SCRIPT_DIR/run.sh" --down > "$shared/reset.log" 2>&1 || reset_rc=$?
  reset_seconds=$(($(date +%s) - reset_started))
  if [ "$reset_rc" -ne 0 ]; then
    printf '\n- Failed stage: `reset`\n- Stage log: `reset.log`\n- Result: FAIL\n' >> "$shared/summary.md"
    result=FAIL
    echo "journey stack reset failed; see $shared/reset.log; next: e2e/journey/run.sh --down" >&2
    total_seconds=$(($(date +%s) - batch_started)); build_seconds=0; unit_seconds=0; candidate_seconds=0; local_seconds=0; secured_seconds=0
    write_metadata "$shared/batch-metadata.json" shared "$result" "$commit" "$BASELINE" "$BUILD_BASE"
    trap - EXIT HUP INT TERM
    return 1
  fi
  preflight_rc=0
  "$SCRIPT_DIR/preflight.sh" "$shared" "$BUILD_BASE" || preflight_rc=$?
  build_seconds=0; unit_seconds=0; candidate_seconds=0
  if [ -s "$shared/stage-durations.env" ]; then
    . "$shared/stage-durations.env"
    build_seconds=$build; candidate_seconds=$candidate; unit_seconds=$unit
    rm -f "$shared/stage-durations.env"
  fi
  if [ "$preflight_rc" -ne 0 ]; then
    failed_stage=${failed_stage:-build}
    printf '\n- Failed stage: `%s`\n- Stage log: `%s.log`\n' "$failed_stage" "$failed_stage" >> "$shared/summary.md"
    result=FAIL
    total_seconds=$(($(date +%s) - batch_started)); local_seconds=0; secured_seconds=0
    write_metadata "$shared/batch-metadata.json" shared "$result" "$commit" "$BASELINE" "$BUILD_BASE"
    printf '\n- Result: FAIL\n' >> "$shared/summary.md"
    trap - EXIT HUP INT TERM
    echo "journey shared $failed_stage stage failed; see $shared/$failed_stage.log; next: e2e/journey/$([ "$failed_stage" = candidate ] && echo prepare-candidate.sh || echo preflight.sh)" >&2
    return "$preflight_rc"
  fi
  archive="$shared/build-candidate.tar"
  pack_started=$(date +%s)
  if ! (
    cd "$ROOT" &&
    pnpm -r list --depth -1 --parseable > "$shared/workspace-packages.txt" &&
    {
      while IFS= read -r package_dir; do
        case "$package_dir" in
          "$ROOT") continue ;;
          "$ROOT"/*) package_path=${package_dir#"$ROOT"/} ;;
          *) echo "workspace package path is outside the checkout: $package_dir" >&2; exit 1 ;;
        esac
        [ ! -d "$package_path/dist" ] || printf './%s/dist\n' "$package_path" >> "$shared/archive-files.txt"
      done < "$shared/workspace-packages.txt"
      for item in .journey/runner-inputs .journey/release .journey/kb-create-release-index e2e/packages; do
        [ ! -e "$item" ] || printf '%s\n' "./$item" >> "$shared/archive-files.txt"
      done
    } &&
    tar -cf "$archive" -T "$shared/archive-files.txt"
  ) > "$shared/candidate-package.log" 2>&1; then
    pack_elapsed=$(($(date +%s) - pack_started))
    candidate_seconds=$((candidate_seconds + pack_elapsed))
    printf '\n- Failed stage: `candidate`\n- Stage log: `candidate-package.log`\n- Result: FAIL\n' >> "$shared/summary.md"
    total_seconds=$(($(date +%s) - batch_started)); local_seconds=0; secured_seconds=0
    write_metadata "$shared/batch-metadata.json" shared FAIL "$commit" "$BASELINE" "$BUILD_BASE"
    trap - EXIT HUP INT TERM
    echo "journey candidate artifact packaging failed; see $shared/candidate-package.log; next: tar -cf \"$archive\" -T \"$shared/archive-files.txt\"" >&2
    return 1
  fi
  pack_elapsed=$(($(date +%s) - pack_started))
  candidate_seconds=$((candidate_seconds + pack_elapsed))
  rm -f "$shared/archive-files.txt" "$shared/workspace-packages.txt"
  result=PASS; total_seconds=$(($(date +%s) - batch_started)); local_seconds=0; secured_seconds=0
  write_metadata "$shared/batch-metadata.json" shared "$result" "$commit" "$BASELINE" "$BUILD_BASE"
  trap - EXIT HUP INT TERM
  return 0
}
run_mode() {
  mode=$1 producer=$(absolute "$2") out=$(absolute "$3")
  selected_cases=$4
  case "$mode" in local|secured) ;; *) usage ;; esac
  shared="$producer/shared"; mode_dir="$out/$mode"
  mkdir -p "$mode_dir"
  cd "$ROOT"
  if [ ! -s "$shared/build-candidate.tar" ]; then
    echo "journey producer artifact is missing its build-candidate.tar; next: rerun the producer with e2e/journey/batch.sh prepare" >&2
    return 1
  fi
  if [ ! -s "$shared/batch-metadata.json" ] || [ ! -s "$shared/run.json" ]; then
    echo "journey producer artifact is missing shared batch metadata; next: rerun the producer with e2e/journey/batch.sh prepare" >&2
    return 1
  fi
  current_commit=$(git rev-parse HEAD) || {
    echo "journey mode could not identify the checked-out commit; next: git rev-parse HEAD" >&2
    return 1
  }
  if ! "${BATCH_PYTHON:-python3}" "$SCRIPT_DIR/batch_summary.py" verify-run "$shared/run.json" "$current_commit"; then
    return 1
  fi
  if ! "${BATCH_PYTHON:-python3}" "$SCRIPT_DIR/batch_summary.py" verify-candidate "$shared/batch-metadata.json" "$shared/build-candidate.tar"; then
    return 1
  fi
  if ! tar -xf "$shared/build-candidate.tar" -C "$ROOT" > "$mode_dir/archive-extract.log" 2>&1; then
    echo "journey producer build-candidate.tar could not be extracted; see $mode_dir/archive-extract.log; next: rerun the producer with e2e/journey/batch.sh prepare" >&2
    return 1
  fi
  for log in reset build unit candidate release-build-output-check; do
    if [ ! -f "$shared/$log.log" ]; then
      echo "journey producer artifact is missing shared/$log.log; next: rerun the producer with e2e/journey/batch.sh prepare" >&2
      return 1
    fi
    if ! cp "$shared/$log.log" "$mode_dir/"; then
      echo "journey producer log shared/$log.log could not be copied; next: rerun the producer with e2e/journey/batch.sh prepare" >&2
      return 1
    fi
  done
  if ! cp "$shared/run.json" "$mode_dir/run.json"; then
    echo "journey producer shared/run.json could not be copied; next: rerun the producer with e2e/journey/batch.sh prepare" >&2
    return 1
  fi
  run_started=$(date +%s)
  if [ -n "$selected_cases" ]; then
    selected_runners_json=$("${BATCH_PYTHON:-python3}" "$SCRIPT_DIR/select_from_cases.py" \
      --runners-for-mode "$mode" "$selected_cases") || {
      echo "journey $mode mode could not resolve selected claim owners; next: rerun e2e/journey/batch.sh mode $mode $producer $out --cases $selected_cases" >&2
      return 1
    }
    runner_selectors=$(printf '%s' "$selected_runners_json" | "${BATCH_PYTHON:-python3}" -c 'import json,sys; print(",".join(json.load(sys.stdin)))')
    if [ -z "$runner_selectors" ]; then
      printf 'no selected claims in this mode\n'
      printf 'no selected claims in this mode\nexit=0\n' > "$mode_dir/batch.log"
      duration=$(($(date +%s) - run_started))
      "${BATCH_PYTHON:-python3}" "$SCRIPT_DIR/batch_summary.py" mode-metadata \
        "$shared/batch-metadata.json" "$mode_dir/batch-metadata.json" "$mode" NO_SELECTED_CLAIMS "$duration" || return 1
      return 0
    fi
  else
    runner_selectors=$("${BATCH_PYTHON:-python3}" "$SCRIPT_DIR/dispatch_registry.py" --batch-mode "$mode") || {
      echo "journey $mode mode runner could not be resolved from the dispatch registry; next: e2e/journey/dispatch_registry.py --batch-mode $mode" >&2
      return 1
    }
    runner_selectors=$(printf '%s' "$runner_selectors" | "${BATCH_PYTHON:-python3}" -c 'import json,sys; print(",".join(json.load(sys.stdin)))')
  fi
  next_runner_command() {
    if [ -n "$selected_cases" ]; then
      printf 'KB_JOURNEY_CASES=%s KB_JOURNEY_SELECTION_MODE=%s KB_JOURNEY_ONLY=%s e2e/journey/run.sh --no-build' \
        "$selected_cases" "$mode" "$runner_selectors"
    else
      printf 'KB_JOURNEY_ONLY=%s e2e/journey/run.sh --no-build' "$runner_selectors"
    fi
  }
  rc=0
  KB_JOURNEY_CASES="$selected_cases" KB_JOURNEY_SELECTION_MODE="$mode" \
    KB_JOURNEY_ONLY="$runner_selectors" "$SCRIPT_DIR/run.sh" --no-build > "$mode_dir/batch.log" 2>&1 || rc=$?
  if [ "$rc" -ne 0 ] && grep -q '^failed to solve:' "$mode_dir/batch.log"; then
    mv "$mode_dir/batch.log" "$mode_dir/infra-failed.log"
    rm -f .journey/reports/*.json .journey/reports/*.log .journey/reports/*.md
    rm -rf .journey/reports/invocations
    rc=0
    KB_JOURNEY_CASES="$selected_cases" KB_JOURNEY_SELECTION_MODE="$mode" \
      KB_JOURNEY_ONLY="$runner_selectors" "$SCRIPT_DIR/run.sh" --no-build > "$mode_dir/batch.log" 2>&1 || rc=$?
    echo "INFRA: first attempt failed during docker image build; retried once" >> "$mode_dir/batch.log"
  fi
  printf 'exit=%s\n' "$rc" >> "$mode_dir/batch.log"
  if ! cp -R .journey/reports/. "$mode_dir/"; then
    rm -f .journey/reports/*.json .journey/reports/*.log .journey/reports/*.md
    rm -rf .journey/reports/invocations
    echo "journey $mode mode reports could not be copied; next: $(next_runner_command)" >&2
    return 1
  fi
  rm -f .journey/reports/*.json .journey/reports/*.log .journey/reports/*.md
  rm -rf .journey/reports/invocations
  duration=$(($(date +%s) - run_started))
  result=PASS; [ "$rc" -eq 0 ] || result=FAIL
  scoreboard_missing=0
  if [ ! -s "$mode_dir/case-scoreboard.json" ]; then
    scoreboard_missing=1
    result=FAIL
  fi
  source_meta="$shared/batch-metadata.json"
  "${BATCH_PYTHON:-python3}" "$SCRIPT_DIR/batch_summary.py" mode-metadata \
    "$source_meta" "$mode_dir/batch-metadata.json" "$mode" "$result" "$duration" || return 1
  if [ "$scoreboard_missing" -eq 1 ]; then
    echo "journey $mode mode produced no case scoreboard (entry exited with $rc); see $mode_dir/batch.log for the cause. Next: $(next_runner_command)" >&2
    return 1
  fi
  if [ "$rc" -ne 0 ]; then
    printf '\n- Failed stage: `%s`\n- Stage log: `%s/batch.log`\n' "$mode" "$mode/batch.log" >> "$mode_dir/batch.log"
    gate_rc=0
    "${BATCH_PYTHON:-python3}" "$SCRIPT_DIR/batch_summary.py" mode-gating "$mode_dir" "$mode" "$producer" "$out" "$selected_cases" || gate_rc=$?
    if [ "$gate_rc" -eq 1 ]; then
      printf 'Result: FAIL (non-gating for Release 1)\n' >> "$mode_dir/batch.log"
      return 0
    fi
    echo "journey $mode mode failed; see $mode_dir/batch.log; next: $(next_runner_command)" >&2
    return "$rc"
  fi
  return 0
}
case "${1:-}" in
  prepare)
    [ "$#" -ge 2 ] && [ "$#" -le 3 ] || usage
    run_prepare "$2" "${3:-$BASELINE}"
    ;;
  mode)
    case "$#" in
      4) selected_cases="" ;;
      6)
        [ "$5" = "--cases" ] || usage
        selected_cases=$6
        case "$selected_cases" in
          *[![:space:]]*) ;;
          *) echo "journey batch --cases requires at least one case or step ID; an empty selection cannot mean a full batch; next: node ./cli/bin/dist/bin.js qa cases list --json" >&2; exit 2 ;;
        esac
        ;;
      *) usage ;;
    esac
    run_mode "$2" "$3" "$4" "$selected_cases"
    ;;
  summarize)
    [ "$#" -eq 5 ] || usage
    "${BATCH_PYTHON:-python3}" "$SCRIPT_DIR/batch_summary.py" "$2" "$3" "$4" "$5"
    ;;
  *)
    [ "$#" -ge 1 ] && [ "$#" -le 2 ] || usage
    full_out=$(absolute "$1"); baseline=${2:-$BASELINE}
    run_prepare "$full_out" "$baseline" || prepare_rc=$?
    producer="$full_out"
    if [ "${prepare_rc:-0}" -eq 0 ]; then
      for mode in local secured; do
        mode_out="$full_out/.artifact-$mode"
        run_mode "$mode" "$producer" "$mode_out" "" || mode_rc=1
      done
      "${BATCH_PYTHON:-python3}" "$SCRIPT_DIR/batch_summary.py" "$full_out" "$producer" "$full_out/.artifact-local" "$full_out/.artifact-secured" || summary_rc=1
    fi
    [ "${prepare_rc:-0}" -eq 0 ] && [ "${summary_rc:-0}" -eq 0 ]
    ;;
esac
