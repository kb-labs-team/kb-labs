#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
source "$ROOT/e2e/compose-owner.sh"
source "$ROOT/e2e/journey/candidate-services.sh"
# Hosted macOS has no container runtime: the lane declares it and the candidate
# service owner runs the same Verdaccio natively.
journey_compose_init "$ROOT" native

node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "$node_major" != "24" ]]; then
  echo "Native Marketplace smoke requires Node 24; found $(node --version)." >&2
  exit 1
fi
if ! command -v corepack >/dev/null 2>&1; then
  echo "Native Marketplace smoke requires Corepack from the Node 24 distribution." >&2
  exit 1
fi
if command -v pnpm >/dev/null 2>&1; then
  echo "Native Marketplace smoke must run without standalone pnpm on PATH." >&2
  exit 1
fi

native_root="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/native-installer-smoke.XXXXXX")"
export HOME="$native_root/home"
mkdir -p "$HOME"
unset KB_PLATFORM_ROOT KB_HOME KB_NET_OFFSET
export NPM_CONFIG_USERCONFIG="$HOME/.npmrc"
export KB_JOURNEY_NATIVE_ROOT="$native_root"
export KB_JOURNEY_CASE_REPORT="$ROOT/.journey/reports/service-native-macos.json"

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if ! journey_stop_host_services; then
    (( status != 0 )) || status=1
  fi
  journey_compose_cleanup
  # Go module-cache directories are intentionally read-only. Make only the
  # disposable tree's directories writable before removing the isolated HOME;
  # file permissions do not prevent unlinking files from writable directories.
  if ! find "$native_root" -type d -exec chmod u+w {} +; then
    echo "Could not make native installer smoke directories removable: $native_root" >&2
    (( status != 0 )) || status=1
  fi
  if ! rm -rf "$native_root"; then
    echo "Could not remove native installer smoke root: $native_root" >&2
    (( status != 0 )) || status=1
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

journey_start_host_services
export NPM_CONFIG_REGISTRY="$JOURNEY_REGISTRY_HOST_URL"
export KB_JOURNEY_REGISTRY_URL="$JOURNEY_REGISTRY_HOST_URL"
export KB_CREATE_DOWNLOAD_BASE_URL="http://origin:8080"
export KB_JOURNEY_CANDIDATE_KB_CREATE="$native_root/kb-create"
node -e 'const fs=require("fs"),path=require("path"),crypto=require("crypto"); const arch=process.arch==="x64"?"amd64":process.arch; const dir=".journey/release/journey-candidate"; const manifest=JSON.parse(fs.readFileSync(path.join(dir,"binary-manifest.json"),"utf8")); const binary=manifest.binaries.find(item=>item.id==="kb-create"&&item.os==="darwin"&&item.arch===arch); if(!binary) throw new Error(`sealed candidate has no darwin/${arch} kb-create`); const source=path.join(dir,binary.filename), bytes=fs.readFileSync(source); if(crypto.createHash("sha256").update(bytes).digest("hex")!==binary.sha256) throw new Error("staged Darwin candidate digest mismatch"); fs.copyFileSync(source,process.env.KB_JOURNEY_CANDIDATE_KB_CREATE); fs.chmodSync(process.env.KB_JOURNEY_CANDIDATE_KB_CREATE,0o755);'
if [[ ! -x "$KB_JOURNEY_CANDIDATE_KB_CREATE" ]]; then
  echo "Sealed Darwin candidate binary is missing or not executable: $KB_JOURNEY_CANDIDATE_KB_CREATE" >&2
  exit 1
fi
node e2e/journey/native-macos-install.mjs
