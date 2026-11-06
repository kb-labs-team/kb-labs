#!/usr/bin/env bash

# Shared candidate origin and package-registry lifecycle for container and
# native installer journeys. Source this file from the owning journey entry.

JOURNEY_HOST_PIDS=()
JOURNEY_HOST_STATE=""
JOURNEY_HOSTS_ADDED=0
JOURNEY_PUBLISHER_ID=""
JOURNEY_REGISTRY_HOST_URL=""

journey_start_registry() {
  if (( ! COMPOSE_AVAILABLE )); then
    echo "Journey registry needs Docker Compose. Next: install Docker Compose and call e2e/journey/run.sh." >&2
    return 2
  fi
  # The Verdaccio volume owns immutable third-party tarballs. Clear only
  # candidate package metadata before the service starts for this run.
  journey_compose run --rm --no-deps --entrypoint sh verdaccio -s -- /verdaccio/storage \
    < e2e/verdaccio/clear-candidates.sh
  journey_compose up -d --wait verdaccio
  local published_port host_port
  published_port=$(journey_compose port verdaccio 4873)
  host_port="${published_port##*:}"
  if [[ -z "$host_port" || "$host_port" == *[!0-9]* ]]; then
    echo "Compose did not return the published Verdaccio port." >&2
    printf 'Next: %s port verdaccio 4873\n' "${JOURNEY_COMPOSE[*]}" >&2
    return 1
  fi
  JOURNEY_REGISTRY_HOST_URL="http://127.0.0.1:$host_port"
  export JOURNEY_REGISTRY_HOST_URL
  echo "Journey registry: $JOURNEY_REGISTRY_HOST_URL (third-party tarball cache retained in the Verdaccio volume)." >&2
}

journey_install_candidate_runtime() {
  local index_path="$1" packages_directory="$2" install_root="$3" root
  journey_compose_require_workspace_source || return
  root="$KB_JOURNEY_WORKSPACE_SOURCE"
  journey_start_registry || return
  (
    cd "$root/tools/kb-create"
    go run ./cmd/candidate-runtime-root \
      --index "$index_path" \
      --packages "$packages_directory" \
      --root "$install_root" \
      --registry "$JOURNEY_REGISTRY_HOST_URL"
  )
}

journey_install_workspace_dependencies() {
  journey_start_registry || return
  pnpm install --frozen-lockfile --registry "$JOURNEY_REGISTRY_HOST_URL"
}

journey_stop_registry() {
  (( ! COMPOSE_AVAILABLE )) && return 0
  journey_compose stop verdaccio >/dev/null
}

journey_start_candidate_registry() {
  local packages_directory="$1" candidate_directory="$2" registry_pipe="$3" root
  journey_compose_require_workspace_source || return
  root="$KB_JOURNEY_WORKSPACE_SOURCE"
  journey_start_registry
  node "$root/e2e/journey/candidate-package-registry.mjs" \
    "$packages_directory" "$candidate_directory" 0 "$JOURNEY_REGISTRY_HOST_URL" > "$registry_pipe" &
  JOURNEY_CANDIDATE_REGISTRY_PID=$!
  if ! IFS= read -r JOURNEY_CANDIDATE_REGISTRY_URL < "$registry_pipe"; then
    echo "Candidate package registry exited before reporting its URL." >&2
    if kill -0 "$JOURNEY_CANDIDATE_REGISTRY_PID" 2>/dev/null; then
      if ! kill "$JOURNEY_CANDIDATE_REGISTRY_PID"; then
        printf 'Could not stop candidate package registry process %s.\n' "$JOURNEY_CANDIDATE_REGISTRY_PID" >&2
        return 1
      fi
      local registry_status
      if wait "$JOURNEY_CANDIDATE_REGISTRY_PID"; then
        :
      else
        registry_status=$?
        if (( registry_status != 143 )); then
          printf 'Candidate package registry process exited with status %s during cleanup.\n' "$registry_status" >&2
          return 1
        fi
      fi
    fi
    JOURNEY_CANDIDATE_REGISTRY_PID=""
    return 1
  fi
  export JOURNEY_CANDIDATE_REGISTRY_URL
  echo "Journey candidate registry: $JOURNEY_CANDIDATE_REGISTRY_URL (upstream $JOURNEY_REGISTRY_HOST_URL)."
}

journey_start_container_services() {
  if (( ! COMPOSE_AVAILABLE )); then
    echo "Journey container services need Docker Compose. Next: install Docker Compose and call e2e/journey/run.sh." >&2
    return 2
  fi
  journey_start_registry
  journey_compose up -d --wait origin
  if [[ ",${COMPOSE_PROFILES:-}," == *",marketplace-registry,"* ]]; then
    journey_compose up -d --wait marketplace-state marketplace-registry marketplace-tamper
  fi
  JOURNEY_PUBLISHER_ID=$(journey_compose run -d --name "journey-publisher-$$" \
    -e "PUBLISHER_DIAGNOSTIC_NEXT=${JOURNEY_COMPOSE[*]} logs verdaccio" publisher)
}

journey_wait_container_publisher() {
  local exit_code log_path
  if [[ -z "$JOURNEY_PUBLISHER_ID" ]]; then
    echo "Journey package publisher was not started. Next: call journey_start_container_services from e2e/journey/run.sh." >&2
    return 2
  fi
  exit_code=$(docker wait "$JOURNEY_PUBLISHER_ID")
  if [[ "$exit_code" != "0" ]]; then
    if ! log_path=$(docker logs "$JOURNEY_PUBLISHER_ID" 2>&1 | python3 e2e/journey/container_outcomes.py --report-dir .journey/reports --write-log-name publisher); then
      echo "Journey package publisher container exited $exit_code; its logs could not be captured or saved. Next: docker logs $JOURNEY_PUBLISHER_ID" >&2
      return 1
    fi
    echo "Journey package publisher container exited $exit_code. Next: cat $log_path" >&2
    return 1
  fi
}

journey_stop_container_services() {
  local status=0
  if [[ -n "$JOURNEY_PUBLISHER_ID" ]]; then
    if ! docker rm -f "$JOURNEY_PUBLISHER_ID" >/dev/null; then
      echo "Could not remove journey publisher container $JOURNEY_PUBLISHER_ID. Next: docker rm -f $JOURNEY_PUBLISHER_ID" >&2
      status=1
    fi
    JOURNEY_PUBLISHER_ID=""
  fi
  (( ! COMPOSE_AVAILABLE )) && return "$status"
  if ! journey_compose stop publisher verdaccio origin >/dev/null; then
    echo "Could not stop journey publisher, Verdaccio, or origin services. Next: e2e/journey/run.sh --down" >&2
    status=1
  fi
  if [[ ",${COMPOSE_PROFILES:-}," == *",marketplace-registry,"* ]] && \
     ! journey_compose stop marketplace-tamper marketplace-registry marketplace-state >/dev/null; then
    echo "Could not stop the opt-in Marketplace Registry services. Next: e2e/journey/run.sh --down" >&2
    status=1
  fi
  return "$status"
}

journey_start_host_services() {
  local root
  journey_compose_require_workspace_source || return
  root="$KB_JOURNEY_WORKSPACE_SOURCE"
  local temp_root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
  local host_line="127.0.0.1 origin"
  journey_start_registry
  JOURNEY_HOST_STATE=$(mktemp -d "$temp_root/kb-journey-host-services.XXXXXX")

  if ! sudo grep -Fqx "$host_line" /etc/hosts; then
    sudo python3 -c 'from pathlib import Path; p=Path("/etc/hosts"); p.write_text(p.read_text()+"127.0.0.1 origin\n")'
    JOURNEY_HOSTS_ADDED=1
  fi

  python3 -m http.server 8080 --directory "$root/.journey/release" > "$JOURNEY_HOST_STATE/origin.log" 2>&1 &
  JOURNEY_HOST_PIDS+=("$!")

  local attempt
  for attempt in {1..60}; do
    if curl --fail --silent http://127.0.0.1:8080/journey-candidate/release-index.json >/dev/null \
      && curl --fail --silent "$JOURNEY_REGISTRY_HOST_URL/-/ping" >/dev/null; then
      PUBLISH_PACKAGES_DIR="$root/e2e/packages" VERDACCIO_URL="$JOURNEY_REGISTRY_HOST_URL" sh "$root/e2e/publisher/publish.sh"
      return
    fi
    if ! kill -0 "${JOURNEY_HOST_PIDS[0]}" 2>/dev/null; then
      echo "Candidate origin stopped before readiness." >&2
      printf 'Next: cat %q\n' "$JOURNEY_HOST_STATE/origin.log" >&2
      return 1
    fi
    sleep 1
  done
  echo "Candidate origin and the Compose Verdaccio service did not become ready within 60 seconds." >&2
  printf 'Next: cat %q; %s logs verdaccio\n' "$JOURNEY_HOST_STATE/origin.log" "${JOURNEY_COMPOSE[*]}" >&2
  return 1
}

journey_stop_host_services() {
  local status=0 pid wait_status
  for pid in ${JOURNEY_HOST_PIDS[@]+"${JOURNEY_HOST_PIDS[@]}"}; do
    if kill -0 "$pid" 2>/dev/null; then
      if ! kill "$pid" 2>/dev/null; then
        printf 'Could not stop candidate service process %s. Next: kill -KILL %s\n' "$pid" "$pid" >&2
        status=1
        continue
      fi
    fi
    if wait "$pid" 2>/dev/null; then
      :
    else
      wait_status=$?
      if (( wait_status != 143 && wait_status != 127 )); then
        echo "Candidate service process $pid exited with status $wait_status." >&2
        status=1
      fi
    fi
  done
  JOURNEY_HOST_PIDS=()
  if ! journey_stop_registry; then
    echo "Could not stop the Compose Verdaccio service. Next: e2e/journey/run.sh --down" >&2
    status=1
  fi
  if (( JOURNEY_HOSTS_ADDED )); then
    sudo python3 -c 'from pathlib import Path; p=Path("/etc/hosts"); line="127.0.0.1 origin"; p.write_text("".join(row for row in p.read_text().splitlines(keepends=True) if row.rstrip("\n") != line))'
    JOURNEY_HOSTS_ADDED=0
  fi
  if [[ -n "$JOURNEY_HOST_STATE" ]]; then
    rm -rf "$JOURNEY_HOST_STATE"
    JOURNEY_HOST_STATE=""
  fi
  JOURNEY_REGISTRY_HOST_URL=""
  return "$status"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  echo "Source e2e/journey/candidate-services.sh from a journey entry." >&2
  exit 2
fi
