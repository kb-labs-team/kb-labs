#!/usr/bin/env bash
status="$1"
report_dir="$2"
started_at="$3"
shift 3
compose=("$@")

container_listing=""
if container_listing=$("${compose[@]}" ps -aq --all); then
  container_ids=()
  while IFS= read -r container_id; do
    [[ -z "$container_id" ]] || container_ids+=(--container "$container_id")
  done <<< "$container_listing"
  if ! python3 e2e/journey/container_outcomes.py --report-dir "$report_dir" \
    --since "$started_at" ${container_ids[@]+"${container_ids[@]}"}; then
    echo "Journey container outcome capture failed; cleanup continues. Next: e2e/journey/run.sh --down" >&2
    status=1
  fi
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" && -f "$report_dir/journey-summary.md" ]]; then
    cat "$report_dir/journey-summary.md" >> "$GITHUB_STEP_SUMMARY"
  fi
else
  echo "Journey container outcome capture failed: Compose could not list containers before teardown. Next: ${compose[*]} ps --all" >&2
  status=1
fi

if ! "${compose[@]}" down --remove-orphans >/dev/null; then
  echo "Journey Compose cleanup failed; run 'e2e/journey/run.sh --down' to remove the journey stack." >&2
  status=1
fi

exit "$status"
