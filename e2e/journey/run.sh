#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
export KB_JOURNEY_GIT_REVISION="$(git rev-parse HEAD)"
export KB_JOURNEY_RUNNER_UID="$(id -u)"
export KB_JOURNEY_RUNNER_GID="$(id -g)"

no_build=0
resolve_only=0
prepare_only=0
compose_action=""
for option in "$@"; do
  case "$option" in
    --no-build) no_build=1 ;;
    --resolve-only) resolve_only=1 ;;
    --prepare-only) prepare_only=1 ;;
    --down|--render-compose-config)
      if [[ -n "$compose_action" ]]; then
        echo "Journey compose actions --down and --render-compose-config cannot be combined." >&2
        exit 2
      fi
      compose_action="$option"
      ;;
    *) echo "Unknown journey option: $option" >&2; exit 2 ;;
  esac
done
if (( resolve_only && prepare_only )); then
  echo "Journey options --resolve-only and --prepare-only cannot be combined." >&2
  exit 2
fi
if [[ -n "$compose_action" ]] && (( resolve_only || prepare_only )); then
  echo "Journey compose actions cannot be combined with --resolve-only or --prepare-only." >&2
  exit 2
fi

if (( resolve_only )); then
  if [[ -n "${KB_JOURNEY_CASES:-}" ]]; then
    python3 e2e/journey/select_from_cases.py
  elif [[ -n "${KB_JOURNEY_ONLY:-}" ]]; then
    python3 e2e/journey/dispatch_registry.py --dispatch "$KB_JOURNEY_ONLY"
  else
    python3 e2e/journey/select_from_cases.py
  fi
  exit
fi
if (( prepare_only )); then
  e2e/journey/prepare-candidate.sh
  exit
fi

selection_json=""
selected_selectors=""
compose_profiles_json='[]'
unset COMPOSE_PROFILES
if [[ -z "$compose_action" && -z "${KB_JOURNEY_ONLY:-}" ]]; then
  python3 e2e/journey/hermetic_cli.py -- node ./cli/bin/dist/bin.js qa cases validate
fi
if [[ -n "${KB_JOURNEY_CASES:-}" ]]; then
  selection_json="$(python3 e2e/journey/select_from_cases.py)"
  selected_selectors="$(python3 -c 'import json,sys; print(",".join(json.load(sys.stdin)["runners"]))' <<< "$selection_json")"
  compose_profiles_json="$(python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["composeProfiles"]))' <<< "$selection_json")"
elif [[ -n "${KB_JOURNEY_ONLY:-}" ]]; then
  selected_selectors="$KB_JOURNEY_ONLY"
  compose_profiles_json="$(python3 e2e/journey/dispatch_registry.py --lanes "$selected_selectors")"
elif [[ -z "$compose_action" ]]; then
  selected_selectors="$(python3 e2e/journey/select_from_cases.py)"
  compose_profiles_json="$(python3 e2e/journey/dispatch_registry.py --lanes "$selected_selectors")"
fi
compose_profiles=""
if [[ -n "$selected_selectors" ]]; then
  compose_profiles="$(python3 -c 'import json,sys; print(",".join(json.load(sys.stdin)))' <<< "$compose_profiles_json")"
fi
if [[ -n "$compose_profiles" ]]; then export COMPOSE_PROFILES="$compose_profiles"; fi
if [[ -n "$selection_json" ]]; then
  export KB_JOURNEY_SELECTED_STEPS="$(python3 -c 'import json,sys; print(",".join(json.load(sys.stdin)["steps"]))' <<< "$selection_json")"
  export KB_JOURNEY_PREREQUISITE_STEPS="$(python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["prerequisiteSteps"]))' <<< "$selection_json")"
  export KB_JOURNEY_PREREQUISITE_FLOWS="$(python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["prerequisiteFlows"]))' <<< "$selection_json")"
  export KB_JOURNEY_SELECTED_OWNING_STEPS="$(python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["selectedOwningSteps"], separators=(",",":")))' <<< "$selection_json")"
  export KB_JOURNEY_SELECTED_CAPABILITIES="$(python3 -c 'import json,sys; print(",".join(json.load(sys.stdin)["capabilities"]))' <<< "$selection_json")"
else
  unset KB_JOURNEY_SELECTED_STEPS KB_JOURNEY_PREREQUISITE_STEPS KB_JOURNEY_PREREQUISITE_FLOWS
  unset KB_JOURNEY_SELECTED_OWNING_STEPS KB_JOURNEY_SELECTED_CAPABILITIES KB_JOURNEY_NEEDED_STATES
fi

ACTIVE_MONITORS=()
MONITORED_CONTAINER_IDS=()
source "$ROOT/e2e/compose-owner.sh"
source "$ROOT/e2e/journey/runner-toolchain.sh"
trap journey_compose_cleanup EXIT
journey_compose_init "$ROOT"
if (( COMPOSE_AVAILABLE )); then COMPOSE=("${JOURNEY_COMPOSE[@]}"); else COMPOSE=(); fi
source "$ROOT/e2e/journey/candidate-services.sh"

if [[ -n "$compose_action" ]]; then
  if (( ! COMPOSE_AVAILABLE )); then
    exit 127
  fi
  if [[ "$compose_action" == "--down" ]]; then
    if journey_compose down --remove-orphans; then compose_status=0; else compose_status=$?; fi
  else
    if journey_compose config --format json; then compose_status=0; else compose_status=$?; fi
  fi
  journey_compose_cleanup
  exit "$compose_status"
fi

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  local monitor_pid monitor_status
  # bash 3.2 (macOS /bin/bash) treats an empty array as unbound under set -u.
  for monitor_pid in ${ACTIVE_MONITORS[@]+"${ACTIVE_MONITORS[@]}"}; do
    if kill -0 "$monitor_pid" 2>/dev/null; then
      if kill "$monitor_pid" 2>/dev/null; then
        monitor_status=143
      else
        monitor_status=0
      fi
      if wait "$monitor_pid"; then
        :
      else
        local wait_status=$?
        if (( wait_status != 143 || monitor_status == 0 )); then
          echo "Journey container metrics monitor $monitor_pid failed with exit $wait_status. Next: cat .journey/reports/container-metrics.jsonl" >&2
          (( status != 0 )) || status=1
        fi
      fi
    elif ! wait "$monitor_pid"; then
      echo "Journey container metrics monitor $monitor_pid failed. Next: cat .journey/reports/container-metrics.jsonl" >&2
      (( status != 0 )) || status=1
    fi
  done
  if (( COMPOSE_AVAILABLE )); then
    if ! journey_stop_container_services; then
      echo "Journey candidate services cleanup failed; run 'e2e/journey/run.sh --down' to remove the journey stack." >&2
      (( status != 0 )) || status=1
    fi
    if [[ -n "${RUN_STARTED_AT:-}" ]]; then
      if ! bash e2e/journey/teardown-compose.sh "$status" .journey/reports "$RUN_STARTED_AT" "${COMPOSE[@]}"; then
        status=1
      fi
    elif ! journey_compose down --remove-orphans >/dev/null; then
      echo "Journey Compose cleanup failed; run 'e2e/journey/run.sh --down' to remove the journey stack." >&2
      (( status != 0 )) || status=1
    fi
  fi
  journey_compose_cleanup
  exit "$status"
}

mkdir -p .journey/reports
export KB_JOURNEY_INVOCATIONS="$ROOT/.journey/reports"

if (( ! COMPOSE_AVAILABLE )); then
  exit 127
fi

dispatch_selector() {
  local selector="$1"
  python3 e2e/journey/dispatch_registry.py --dispatch "$selector"
}

run_selector() {
  local selectors="$1" selector runner_json had_profile=0 saved_profile="${KB_JOURNEY_SERVICE_PROFILE:-}"
  [[ "${KB_JOURNEY_SERVICE_PROFILE+x}" == "x" ]] && had_profile=1
  while IFS= read -r selector; do
    [[ -z "$selector" ]] && continue
    runner_json="$(dispatch_selector "$selector")"
    while IFS=$'\t' read -r runner_selector front scenario variant profile; do
      unset KB_JOURNEY_SERVICE_PROFILE
      if [[ -n "$profile" ]]; then export KB_JOURNEY_SERVICE_PROFILE="$profile"; fi
      run_journey "$runner_selector" "$front" "$scenario" "$variant"
    done < <(python3 -c 'import json,sys; print("\n".join("\t".join((d["selector"],d["front_door"],d["scenario"],d["variant"],d["service_profile"])) for d in json.load(sys.stdin)))' <<< "$runner_json")
  done <<< "$(printf '%s' "$selectors" | tr ',' '\n')"
  if (( had_profile )); then export KB_JOURNEY_SERVICE_PROFILE="$saved_profile"; else unset KB_JOURNEY_SERVICE_PROFILE; fi
}

trap cleanup EXIT INT TERM

RUN_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

if (( ! no_build )); then
  e2e/journey/install-workspace-dependencies.sh
  kb-devkit run build --affected
  e2e/journey/prepare-candidate.sh
fi

start_container_monitor() {
  python3 e2e/journey/container_outcomes.py --monitor "$1" --report-dir .journey/reports &
  ACTIVE_MONITORS+=("$!")
  MONITORED_CONTAINER_IDS+=("$1")
}

start_project_container_monitors() {
  local container_id container_listing
  container_listing=$(journey_compose ps -aq --all)
  while IFS= read -r container_id; do
    [[ -z "$container_id" ]] && continue
    case " ${MONITORED_CONTAINER_IDS[*]-} " in
      *" $container_id "*) ;;
      *) start_container_monitor "$container_id" ;;
    esac
  done <<< "$container_listing"
}

mkdir -p .journey/reports
rm -f .journey/reports/journey-summary.md
find .journey/reports -maxdepth 1 -type d -name 'platform-state-*' -exec rm -rf {} +
journey_toolchain_ensure "$ROOT"
journey_compose build publisher runner idp-stub
if [[ ",${COMPOSE_PROFILES:-}," == *",marketplace-registry,"* ]]; then
  journey_compose build marketplace-state marketplace-registry
fi
journey_start_container_services
start_project_container_monitors
journey_wait_container_publisher

run_journey() {
  local runner_selector="$1" front_door="$2" scenario="$3" variant="$4"
  local container_name="journey-runner-$$-${RUN_INDEX}" container_id container_exit
  RUN_INDEX=$((RUN_INDEX + 1))
  echo "==> $front_door / $scenario / $variant"
  if ! container_id=$(KB_JOURNEY_RUNNER_SELECTOR="$runner_selector" KB_JOURNEY_SCENARIO="$scenario" KB_JOURNEY_FRONT_DOOR="$front_door" KB_JOURNEY_VARIANT="$variant" \
    journey_compose run -d --name "$container_name" -e KB_JOURNEY_SCENARIO -e KB_JOURNEY_FRONT_DOOR -e KB_JOURNEY_VARIANT \
    -e KB_JOURNEY_RUNNER_SELECTOR -e KB_JOURNEY_SERVICE_PROFILE -e KB_JOURNEY_CASES -e KB_JOURNEY_SELECTED_STEPS \
    -e KB_JOURNEY_PREREQUISITE_STEPS -e KB_JOURNEY_PREREQUISITE_FLOWS \
    -e KB_JOURNEY_SELECTED_OWNING_STEPS -e KB_JOURNEY_SELECTED_CAPABILITIES runner < /dev/null); then
    status=1
    return
  fi
  start_container_monitor "$container_id"
  start_project_container_monitors
  if ! container_exit=$(docker wait "$container_id"); then
    echo "Could not wait for journey runner container $container_id. Next: cat .journey/reports/container-outcomes.json" >&2
    status=1
  elif [[ "$container_exit" != "0" ]]; then
    echo "Journey runner container $container_id exited $container_exit. Next: cat .journey/reports/container-outcomes.json" >&2
    status=1
  fi
}

RUN_INDEX=0
status=0
if [[ -n "${KB_JOURNEY_CASES:-}" ]]; then
  run_selector "$selected_selectors"
elif [[ -n "${KB_JOURNEY_ONLY:-}" ]]; then
  run_selector "$KB_JOURNEY_ONLY"
else
  if [[ -n "$selected_selectors" ]]; then while IFS= read -r selector; do
    if ! run_selector "$selector"; then status=1; fi
  done <<< "$(printf '%s' "$selected_selectors" | tr ',' '\n')"; fi
fi

echo "Journey matrix complete (exit $status)"
exit "$status"
