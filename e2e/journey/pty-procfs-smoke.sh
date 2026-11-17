#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# Match the UID/GID selection in run.sh exactly. Rendering through that entry
# also validates the production Compose inputs without printing its environment.
export KB_JOURNEY_RUNNER_UID="$(id -u)"
export KB_JOURNEY_RUNNER_GID="$(id -g)"
export KB_JOURNEY_GIT_REVISION="$(git rev-parse HEAD)"
export KB_JOURNEY_NODE_BASE_IMAGE="$(node -p 'require("./tools/clikit/toolchain/node_policy_gen.json").nodeBaseImage')"
export KB_JOURNEY_WORKSPACE_SOURCE="$ROOT"
export KB_JOURNEY_PTY_WIZARD_MODE="${KB_JOURNEY_PTY_WIZARD_MODE:-fixture}"
export KB_JOURNEY_PTY_RELEASE_INDEX="${KB_JOURNEY_PTY_RELEASE_INDEX:-$ROOT/tools/kb-create/v2/cmd/kb-create-v2/testdata/x251-release-index.json}"

rendered_config="$(mktemp "${TMPDIR:-/tmp}/journey-pty-compose.XXXXXX.json")"
wizard_binary="${KB_JOURNEY_PTY_WIZARD_BINARY:-}"
generated_wizard_binary=""
if [[ -z "$wizard_binary" ]]; then
  generated_wizard_binary="$(mktemp "${TMPDIR:-/tmp}/journey-pty-wizard.XXXXXX")"
  wizard_binary="$generated_wizard_binary"
  (
  cd "$ROOT/tools/kb-create"
  CGO_ENABLED=0 GOTOOLCHAIN=auto go build -trimpath -o "$wizard_binary" ./v2/testsupport/wizard-pty
  )
  chmod 0755 "$wizard_binary"
fi
trap 'rm -f "$rendered_config" "$generated_wizard_binary"' EXIT
export KB_JOURNEY_PTY_WIZARD_BINARY="$wizard_binary"

e2e/journey/run.sh --render-compose-config > "$rendered_config"

python3 - "$rendered_config" <<'PY'
import json
import os
import sys

with open(sys.argv[1], encoding="utf-8") as stream:
    config = json.load(stream)
services = config.get("services", {})
runner = services.get("runner", {})
expected_user = f"{os.environ['KB_JOURNEY_RUNNER_UID']}:{os.environ['KB_JOURNEY_RUNNER_GID']}"
if str(runner.get("user", "")) != expected_user:
    raise SystemExit("rendered journey runner user does not match run.sh host UID/GID")
if runner.get("cap_add") != ["SYS_PTRACE"]:
    raise SystemExit("rendered journey runner must have only CAP_SYS_PTRACE added")
if runner.get("privileged", False):
    raise SystemExit("rendered journey runner must not be privileged")
if runner.get("pid") == "host":
    raise SystemExit("rendered journey runner must keep its private PID namespace")
if any("unconfined" in option for option in runner.get("security_opt", [])):
    raise SystemExit("rendered journey runner must keep the default seccomp profile")
if any(service.get("cap_add") for name, service in services.items() if name != "runner"):
    raise SystemExit("CAP_SYS_PTRACE must not be added to another journey service")
print("Rendered journey runner config guardrails PASS")
PY

source e2e/compose-owner.sh
compose_owner_init
COMPOSE=("${COMPOSE_OWNER_COMMAND[@]}")
"${COMPOSE[@]}" \
  -f e2e/docker-compose.yml \
  -f e2e/journey/docker-compose.yml \
  -f e2e/journey/pty-procfs-smoke.override.yml \
  run --build --rm --no-deps runner
