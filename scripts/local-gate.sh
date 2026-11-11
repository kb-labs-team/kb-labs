#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
MODE="${1:-}"
shift || true
DRY_RUN=0
KEEP_GOING=0
FULL=0
PACKAGES=""
while (($#)); do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --keep-going) KEEP_GOING=1 ;;
    --full) FULL=1 ;;
    --packages) (($# >= 2)) || { echo "local-gate: --packages needs a comma-separated value" >&2; exit 2; }; PACKAGES="$2"; shift ;;
    *) echo "local-gate: unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
[[ "$MODE" == quick || "$MODE" == batch ]] || { echo "Usage: scripts/local-gate.sh quick [--packages a,b] [--dry-run] | batch [--full] [--dry-run] [--keep-going]" >&2; exit 2; }
if [[ "$MODE" == quick && "$FULL" == 1 ]]; then echo "local-gate: --full is only available with batch" >&2; exit 2; fi
if ! command -v go >/dev/null 2>&1; then
  echo "local-gate: Go 1.26 is required to build kb-devkit from this checkout." >&2
  echo "Install Go from https://go.dev/dl/ (Homebrew: brew install go), then rerun: scripts/local-gate.sh $MODE" >&2
  exit 127
fi

DEVKIT_DIR=""
DEVKIT_BIN=""
build_devkit() {
  DEVKIT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/kb-devkit-local-gate.XXXXXX")"
  if ! (cd "$ROOT/tools/kb-devkit" && go build -o "$DEVKIT_DIR/kb-devkit" .); then
    echo "local-gate: could not build kb-devkit from this checkout; next run: make -C tools/kb-devkit build" >&2
    return 1
  fi
  chmod +x "$DEVKIT_DIR/kb-devkit"
  DEVKIT_BIN="$DEVKIT_DIR/kb-devkit"
}
cleanup_devkit() {
  if [[ -n "$DEVKIT_DIR" ]]; then
    chmod -R u+w "$DEVKIT_DIR" 2>/dev/null || true
    rm -rf "$DEVKIT_DIR"
  fi
}
trap cleanup_devkit EXIT

if [[ "$MODE" == quick ]]; then
  if [[ -z "$PACKAGES" ]]; then
    git rev-parse --verify local/main >/dev/null 2>&1 || { echo "local-gate: local/main is required; update the local main ref, then rerun this command" >&2; exit 2; }
    PACKAGES="$(python3 - <<'PY'
import json, pathlib, subprocess
files=set()
for args in (["git","diff","--name-only","local/main...HEAD"],["git","diff","--name-only"],["git","diff","--name-only","--cached"]):
    files.update(subprocess.check_output(args,text=True).splitlines())
names=set()
for file in files:
    current=pathlib.Path(file).parent
    while str(current) not in (".", "/"):
        manifest=current/"package.json"
        if manifest.is_file():
            name=json.loads(manifest.read_text()).get("name")
            if name: names.add(name)
            break
        current=current.parent
print(",".join(sorted(names)))
PY
)"
  fi
  [[ -n "$PACKAGES" ]] || { echo "local-gate: no changed packages found; use --packages a,b to select packages" >&2; exit 2; }
  IFS=, read -r -a package_list <<< "$PACKAGES"
  if ((DRY_RUN)); then
    printf 'quick packages: %s\n' "$PACKAGES"
    for package in "${package_list[@]}"; do
      echo "pnpm --filter $package run type-check (when declared)"
      echo "pnpm --filter $package run test (when declared)"
    done
    echo "go test changed tools/kb-create packages with an isolated HOME"
    exit 0
  fi
  build_devkit
  for package in "${package_list[@]}"; do
    "$DEVKIT_BIN" run type-check test --packages "$package"
  done
  go_packages="$(python3 - <<'PY'
import pathlib, subprocess
files=set()
for args in (["git","diff","--name-only","local/main...HEAD"],["git","diff","--name-only"],["git","diff","--name-only","--cached"]):
    files.update(subprocess.check_output(args,text=True).splitlines())
print("\n".join(sorted({"./"+str(pathlib.Path(f).parent.relative_to("tools/kb-create")) for f in files if f.startswith("tools/kb-create/") and f.endswith(".go")})))
PY
)"
  if [[ -n "$go_packages" ]]; then
    isolated_home="$(mktemp -d)"
    trap 'chmod -R u+w "$isolated_home" 2>/dev/null || true; rm -rf "$isolated_home"; cleanup_devkit' EXIT
    while IFS= read -r package; do (cd "$ROOT/tools/kb-create" && env -u KB_PLATFORM_ROOT -u KB_HOME -u KB_NET_OFFSET HOME="$isolated_home" go test "$package"); done <<< "$go_packages"
  fi
  exit 0
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$ROOT/.kb/local-gate/$STAMP"
git rev-parse --verify local/main >/dev/null 2>&1 || { echo "local-gate: local/main is required; update the local main ref, then rerun batch" >&2; exit 2; }
changed_packages="$(python3 - <<'PY'
import json, pathlib, subprocess
files=set()
for args in (["git","diff","--name-only","local/main...HEAD"],["git","diff","--name-only"],["git","diff","--name-only","--cached"]):
    files.update(subprocess.check_output(args,text=True).splitlines())
names=set()
for file in files:
    current=pathlib.Path(file).parent
    while str(current) not in (".", "/"):
        manifest=current/"package.json"
        if manifest.is_file():
            name=json.loads(manifest.read_text()).get("name")
            if name: names.add(name)
            break
        current=current.parent
print(",".join(sorted(names)))
PY
)"
[[ -n "$changed_packages" ]] || { echo "local-gate: no changed workspace packages found relative to local/main" >&2; exit 2; }
go_packages="$(python3 - <<'PY'
import pathlib, subprocess
files=set()
for args in (["git","diff","--name-only","local/main...HEAD"],["git","diff","--name-only"],["git","diff","--name-only","--cached"]):
    files.update(subprocess.check_output(args,text=True).splitlines())
print("\n".join(sorted({"./"+str(pathlib.Path(f).parent.relative_to("tools/kb-create")) for f in files if f.startswith("tools/kb-create/") and f.endswith(".go")})))
PY
)"
[[ -n "$go_packages" ]] || go_packages="./v2"
STAGE_NAMES=()
STAGE_NAMES+=( 'frozen install' 'affected build' 'QA case catalog validation' 'affected lint type-check tests' )
while IFS= read -r package; do STAGE_NAMES+=("kb-create Go tests $package"); done <<< "$go_packages"
STAGE_NAMES+=( 'dependency audit' 'secret scan' 'prepare service journey candidate' 'Colima start' )
if ((FULL)); then STAGE_NAMES+=( 'full release case journey matrix' ); else STAGE_NAMES+=( 'local install and service journey' 'secured install and service journey' ); fi
STAGE_NAMES+=( 'nightly journey aggregation' )
GO_STAGE_START=4
AUDIT_STAGE=$((GO_STAGE_START + $(wc -l <<< "$go_packages" | tr -d ' ')))
SECRET_STAGE=$((AUDIT_STAGE + 1)); CANDIDATE_STAGE=$((AUDIT_STAGE + 2)); COLIMA_STAGE=$((AUDIT_STAGE + 3))
JOURNEY_STAGE=$((AUDIT_STAGE + 4))
if ((FULL)); then AGGREGATION_STAGE=$((AUDIT_STAGE + 5)); else
  LOCAL_JOURNEY_STAGE=$JOURNEY_STAGE; SECURED_JOURNEY_STAGE=$((JOURNEY_STAGE + 1)); AGGREGATION_STAGE=$((AUDIT_STAGE + 6))
fi
STAGE_NAMES+=( 'local release-case coverage' 'secured release-case coverage' )
if ((DRY_RUN)); then
  for i in "${!STAGE_NAMES[@]}"; do printf '%d. %s\n' "$((i + 1))" "${STAGE_NAMES[$i]}"; done
  if ((KEEP_GOING)); then echo 'keep-going: continue after failed stages; final status remains non-zero'; fi
  exit 0
fi
build_devkit
mkdir -p "$OUT"
REPORT="$OUT/report.md"; JSON="$OUT/report.json"
START="$(date -u +%FT%TZ)"; FIRST_FAILURE=""; STATUS=0; STAGES=()
cleanup() {
  local result=$?
  if [[ -n "${COLIMA_STARTED:-}" ]]; then
    local current_id
    for image in kb-installer-journey:local kb-e2e-ci-publisher:latest kb-e2e-ci-platform:latest; do
      current_id="$(docker image inspect -f '{{.Id}}' "$image" 2>/dev/null || true)"
      if [[ -n "$current_id" && " ${TASK_IMAGE_IDS_BEFORE:-} " != *" $current_id "* ]]; then docker image rm "$current_id" || STATUS=1; fi
    done
  fi
  if [[ -n "${COLIMA_STARTED:-}" ]]; then colima stop || STATUS=1; fi
  if [[ -n "${TEMP_HOME:-}" ]]; then chmod -R u+w "$TEMP_HOME" 2>/dev/null || true; rm -rf "$TEMP_HOME"; fi
  cleanup_devkit
  python3 - "$JSON" "$START" "$FIRST_FAILURE" "$STATUS" "$OUT/capabilities.json" "${STAGES[@]}" <<'PY'
import json,os,sys
path,start,first,status,*stages=sys.argv[1:]
capability_path, *stages = stages
capability_report=json.load(open(capability_path)) if os.path.isfile(capability_path) else None
def stage_record(value):
    name, result, duration, *reason = value.split('|', 3)
    return {'name':name, 'status':result, 'duration_seconds':int(duration) if duration else None,
            'reason':reason[0] if reason else None}
json.dump({'started_at':start,'status':'PASS' if status=='0' else 'FAIL','first_failure':first or None,
           'stages':[stage_record(x) for x in stages],
           'capabilities': capability_report.get('capabilities',[]) if capability_report else [],
           'failed_steps':[item['first_failure'] for item in capability_report.get('capabilities',[]) if item.get('first_failure')] if capability_report else []},open(path,'w'),indent=2)
PY
  { echo "# Local gate report"; echo; echo "Started: $START"; echo "Status: $([[ $STATUS == 0 ]] && echo PASS || echo FAIL)"; echo "First failing stage: ${FIRST_FAILURE:-none}"; echo; echo '| Stage | Status | Duration (s) | Reason |'; echo '|---|---:|---:|---|'; for item in "${STAGES[@]}"; do IFS='|' read -r name stage_status duration reason <<< "$item"; printf '| %s | %s | %s | %s |\n' "$name" "$stage_status" "$duration" "${reason:-}"; done; if [[ -f "$OUT/capabilities.md" ]]; then echo; cat "$OUT/capabilities.md"; fi; echo; echo "Artifacts: $OUT"; } > "$REPORT"
  [[ "$STATUS" == 0 ]] || result=1
  exit "$result"
}
trap cleanup EXIT INT TERM
stage() {
  local name="$1"; shift
  local started ended duration
  started="$(date +%s)"
  echo "==> $name"
  if "$@"; then
    ended="$(date +%s)"
    duration="$((ended - started))"
    STAGES+=("$name|PASS|$duration")
    LAST_STAGE_EXIT=0
  else
    ended="$(date +%s)"
    duration="$((ended - started))"
    STAGES+=("$name|FAIL|$duration")
    LAST_STAGE_EXIT=1
    FIRST_FAILURE="${FIRST_FAILURE:-$name}"
    STATUS=1
    return "$((1 - KEEP_GOING))"
  fi
}
block_stage() {
  local name="$1" reason="$2"
  STAGES+=("$name|BLOCKED|0|$reason")
  STATUS=1
}
stage "${STAGE_NAMES[0]}" env CI=true pnpm install --frozen-lockfile || exit 1
[[ "$LAST_STAGE_EXIT" == 0 ]] || INSTALL_FAILED=1
if [[ "${INSTALL_FAILED:-0}" == 1 ]]; then
  block_stage "${STAGE_NAMES[1]}" 'blocked because frozen install failed'
  block_stage "${STAGE_NAMES[2]}" 'blocked because frozen install failed'
  block_stage "${STAGE_NAMES[3]}" 'blocked because frozen install failed'
  for ((go_index=0; go_index < AUDIT_STAGE-GO_STAGE_START; go_index++)); do block_stage "${STAGE_NAMES[$((GO_STAGE_START + go_index))]}" 'blocked because frozen install failed'; done
  block_stage "${STAGE_NAMES[$CANDIDATE_STAGE]}" 'blocked because frozen install failed'
  block_stage "${STAGE_NAMES[$COLIMA_STAGE]}" 'blocked because frozen install failed'
  block_stage "${STAGE_NAMES[$JOURNEY_STAGE]}" 'blocked because frozen install failed'
  if ((!FULL)); then block_stage "${STAGE_NAMES[$((JOURNEY_STAGE + 1))]}" 'blocked because frozen install failed'; fi
  block_stage "${STAGE_NAMES[$AGGREGATION_STAGE]}" 'blocked because frozen install failed'
else
stage "${STAGE_NAMES[1]}" env KB_DEVKIT_BASE_REF=local/main...HEAD "$DEVKIT_BIN" run build --affected || exit 1
if [[ ! -f "$ROOT/cli/bin/dist/bin.js" ]]; then
  echo "local-gate: built workspace CLI is missing at $ROOT/cli/bin/dist/bin.js; run: kb-devkit run build --affected" >&2
  exit 1
fi
stage "${STAGE_NAMES[2]}" node ./cli/bin/dist/bin.js qa cases validate || exit 1
# The release plugin (Commit) suites always run: a change elsewhere must not
# leave the only release-contour plugin untested (they were red unnoticed).
RELEASE_PLUGIN_PACKAGES='@kb-labs/commit,@kb-labs/commit/core'
stage "${STAGE_NAMES[3]}" bash -c 'env KB_DEVKIT_BASE_REF=local/main...HEAD "$1" run lint type-check test --affected && "$1" run test --packages "$2"' _ "$DEVKIT_BIN" "$RELEASE_PLUGIN_PACKAGES" || exit 1
TEMP_HOME="$(mktemp -d "${TMPDIR:-/tmp}/kb-create-local-gate.XXXXXX")"
go_index=0
while IFS= read -r package; do stage "${STAGE_NAMES[$((GO_STAGE_START + go_index))]}" bash -c 'cd tools/kb-create && env -u KB_PLATFORM_ROOT -u KB_HOME -u KB_NET_OFFSET HOME="$1" go test "$2"' _ "$TEMP_HOME" "$package" || exit 1; go_index=$((go_index + 1)); done <<< "$go_packages"
fi
stage "${STAGE_NAMES[$AUDIT_STAGE]}" pnpm audit --audit-level moderate || exit 1
stage "${STAGE_NAMES[$SECRET_STAGE]}" gitleaks detect --source . --config .gitleaks.toml --redact --no-banner || exit 1
if [[ "${INSTALL_FAILED:-0}" == 1 ]]; then
  JOURNEY_CANDIDATE_READY=0
else
  stage "${STAGE_NAMES[$CANDIDATE_STAGE]}" e2e/journey/prepare-candidate.sh || exit 1
  if [[ "$LAST_STAGE_EXIT" == 0 ]]; then JOURNEY_CANDIDATE_READY=1; else JOURNEY_CANDIDATE_READY=0; ((KEEP_GOING)) || exit 1; fi
fi
if ((JOURNEY_CANDIDATE_READY)); then
  if stage "${STAGE_NAMES[$COLIMA_STAGE]}" colima start; then COLIMA_STARTED=1; elif (( ! KEEP_GOING )); then exit 1; fi
  TASK_IMAGE_IDS_BEFORE=""
  for image in kb-installer-journey:local kb-e2e-ci-publisher:latest kb-e2e-ci-platform:latest; do
    image_id="$(docker image inspect -f '{{.Id}}' "$image" 2>/dev/null || true)"
    [[ -z "$image_id" ]] || TASK_IMAGE_IDS_BEFORE+="$image_id "
  done
else
  if [[ "${INSTALL_FAILED:-0}" == 1 ]]; then block_stage "${STAGE_NAMES[$COLIMA_STAGE]}" 'blocked because frozen install failed';
  else block_stage "${STAGE_NAMES[$COLIMA_STAGE]}" 'blocked because candidate preparation failed'; fi
fi
mkdir -p .journey/reports
rm -f .journey/reports/service-local.json .journey/reports/service-secured.json .journey/reports/service-auth-local.json .journey/reports/service-auth-secured.json
if ((JOURNEY_CANDIDATE_READY)); then
if ((FULL)); then
stage "${STAGE_NAMES[$JOURNEY_STAGE]}" e2e/journey/run.sh --no-build || true
FULL_JOURNEY_EXIT="$LAST_STAGE_EXIT"
stage "${STAGE_NAMES[$AGGREGATION_STAGE]}" python3 e2e/journey/nightly_report.py --results .journey/reports --profile local --profile secured \
  --journey-exit "local=$FULL_JOURNEY_EXIT" --journey-exit "secured=$FULL_JOURNEY_EXIT" \
  --json "$OUT/capabilities.json" --summary "$OUT/capabilities.md" || true
else
stage "${STAGE_NAMES[$LOCAL_JOURNEY_STAGE]}" env KB_JOURNEY_ONLY=service-local:explore e2e/journey/run.sh --no-build || true
LOCAL_JOURNEY_EXIT="$LAST_STAGE_EXIT"
stage "${STAGE_NAMES[$SECURED_JOURNEY_STAGE]}" env KB_JOURNEY_ONLY=service-secured:explore e2e/journey/run.sh --no-build || true
SECURED_JOURNEY_EXIT="$LAST_STAGE_EXIT"
stage "${STAGE_NAMES[$AGGREGATION_STAGE]}" python3 e2e/journey/nightly_report.py --results .journey/reports --profile local --profile secured \
  --journey-exit "local=$LOCAL_JOURNEY_EXIT" --journey-exit "secured=$SECURED_JOURNEY_EXIT" \
  --json "$OUT/capabilities.json" --summary "$OUT/capabilities.md" || true
fi
else
  if [[ "${INSTALL_FAILED:-0}" != 1 ]]; then
    block_stage "${STAGE_NAMES[$JOURNEY_STAGE]}" 'blocked because candidate preparation failed'
    if ((!FULL)); then block_stage "${STAGE_NAMES[$((JOURNEY_STAGE + 1))]}" 'blocked because candidate preparation failed'; fi
    block_stage "${STAGE_NAMES[$AGGREGATION_STAGE]}" 'blocked because candidate preparation failed'
  fi
  block_stage "${STAGE_NAMES[$((AGGREGATION_STAGE + 1))]}" 'blocked because journey candidate is unavailable'
  block_stage "${STAGE_NAMES[$((AGGREGATION_STAGE + 2))]}" 'blocked because journey candidate is unavailable'
fi
if ((JOURNEY_CANDIDATE_READY)); then
  stage 'local release-case coverage' node ./cli/bin/dist/bin.js qa coverage show --level release --mode local --run .journey/reports/service-local.json || exit 1
  stage 'secured release-case coverage' node ./cli/bin/dist/bin.js qa coverage show --level release --mode secured --run .journey/reports/service-secured.json || exit 1
fi
[[ "$STATUS" == 0 ]] || exit 1
exit 0
