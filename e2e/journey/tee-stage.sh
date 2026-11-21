#!/usr/bin/env bash
# tee-stage.sh <log-path> <stage-name> <command> [args...]
# Stream a stage to the caller while retaining its complete log and exit status.
set -uo pipefail

if [ "$#" -lt 3 ]; then
  echo "usage: tee-stage.sh <log-path> <stage-name> <command> [args...]" >&2
  exit 2
fi

log_path=$1
stage_name=$2
shift 2
started=$(date +%s)

printf '\n===== %s started =====\n' "$stage_name" | tee -a "$log_path"
header_status=${PIPESTATUS[1]}
if [ "$header_status" -ne 0 ]; then
  echo "${stage_name}: failed to write stage header to its log" >&2
  exit "$header_status"
fi
"$@" 2>&1 | tee -a "$log_path"
statuses=("${PIPESTATUS[@]}")
command_status=${statuses[0]}
tee_status=${statuses[1]}

elapsed=$(($(date +%s) - started))
printf '===== %s finished: exit %s (%ss) =====\n' "$stage_name" "$command_status" "$elapsed" | tee -a "$log_path"
if [ "$command_status" -ne 0 ]; then
  exit "$command_status"
fi
exit "$tee_status"
