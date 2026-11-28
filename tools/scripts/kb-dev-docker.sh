#!/usr/bin/env bash
#
# kb-dev-docker.sh — `kb-dev` proxy that runs inside the platform container.
#
# Used by CI where the runner sits on the GH Actions host but the platform
# (and its kb-dev binary) lives in a sibling Docker container. Set this
# script as the runner's `KB_DEV_BIN` and the runner stays unaware of
# containers — it just calls `kb-dev`, the wrapper translates paths and
# forwards to the container.
#
# Path translation: any positional arg that starts with KB_HOST_E2E
# (default: `$GITHUB_WORKSPACE/e2e` or `<repo-with-.git>/e2e`) is rewritten
# to start with KB_CONTAINER_E2E (default: `/workspace/e2e-host`). This
# matches the bind mount declared in `e2e/docker-compose.yml`.
#
# Environment:
#   KB_HOST_E2E         host path to repo's `e2e/` directory
#                       (default: `${GITHUB_WORKSPACE:-<repo>}/e2e`)
#   KB_CONTAINER_E2E    mount path inside the container
#                       (default: `/workspace/e2e-host`)
#   KB_CONTAINER_WORKDIR  workdir for `docker compose exec`
#                         (default: `/workspace/kb-e2e`)
#   KB_DOCKER_TARGET    docker compose service name (default: `platform`)

set -euo pipefail

# Repo root anchors path translation AND `docker compose` lookup. The runner
# is invoked from a per-domain CWD like `<repo>/e2e/gateway`; without
# rebasing we'd fail to locate `e2e/docker-compose.yml`.
REPO_ROOT="${GITHUB_WORKSPACE:-}"
if [[ -z "$REPO_ROOT" ]]; then
  # Fall back to walking up for the `.git` marker so the script is usable
  # outside GitHub Actions too.
  cand="$PWD"
  while [[ "$cand" != "/" && ! -e "$cand/.git" ]]; do
    cand="$(dirname "$cand")"
  done
  # Loop above exits at `/` whether or not `.git` was found — verify
  # explicitly. Falling back to `/` would silently make HOST_E2E=`/e2e`,
  # mistranslate every path, and produce a confusing `docker compose`
  # error after the fact.
  if [[ ! -e "$cand/.git" ]]; then
    echo "kb-dev-docker.sh: cannot locate repo root — set GITHUB_WORKSPACE or run from inside a git checkout (no .git found while walking up from $PWD)" >&2
    exit 1
  fi
  REPO_ROOT="$cand"
fi

HOST_E2E="${KB_HOST_E2E:-$REPO_ROOT/e2e}"
CONTAINER_E2E="${KB_CONTAINER_E2E:-/workspace/e2e-host}"
CONTAINER_WORKDIR="${KB_CONTAINER_WORKDIR:-/workspace/kb-e2e}"
TARGET="${KB_DOCKER_TARGET:-platform}"

translated=()
for arg in "$@"; do
  # `${var#pattern}` parameter expansion treats `pattern` as a glob. Wrap
  # `$HOST_E2E` in single-element quoted form so brackets/asterisks/etc.
  # in a self-hosted runner's workspace path are matched literally.
  if [[ "$arg" == "$HOST_E2E"/* ]]; then
    arg="$CONTAINER_E2E/${arg#"$HOST_E2E"/}"
  fi
  translated+=("$arg")
done

cd "$REPO_ROOT"
# Gateway pressure changes the disposable installed platform configuration.
if [[ "${E2E_SUITE:-}" == gateway && $# == 3 && "$1" == ensure && "$2" == --scenario ]]; then
  case "${translated[2]}" in
    default|"$CONTAINER_E2E/gateway/scenarios/default/scenario.yaml") scenario=default ;;
    "$CONTAINER_E2E/gateway/scenarios/pressure/scenario.yaml") scenario=pressure ;;
  esac
  if [[ -n "${scenario:-}" ]]; then
    exec docker compose exec -T -w "$CONTAINER_WORKDIR" "$TARGET" \
      sh "$CONTAINER_E2E/gateway/scripts/installed-scenario.sh" "$scenario"
  fi
fi
exec docker compose exec -T -w "$CONTAINER_WORKDIR" "$TARGET" kb-dev "${translated[@]}"
