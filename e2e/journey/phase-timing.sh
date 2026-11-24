#!/usr/bin/env bash

# Searchable UTC markers for long candidate-preparation phases. Bash's SECONDS
# counter measures elapsed time monotonically within the calling process.
journey_phase_start() {
  JOURNEY_PHASE_NAME="$1"
  JOURNEY_PHASE_STARTED_SECONDS=$SECONDS
  printf '[%s] phase=start name=%s\n' \
    "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$JOURNEY_PHASE_NAME" >&2
}

journey_phase_end() {
  local result="${1:-complete}"
  printf '[%s] phase=%s name=%s elapsed_seconds=%d\n' \
    "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$result" \
    "$JOURNEY_PHASE_NAME" "$((SECONDS - JOURNEY_PHASE_STARTED_SECONDS))" >&2
  JOURNEY_PHASE_NAME=''
}
