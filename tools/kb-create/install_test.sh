#!/usr/bin/env bash
# Test suite for install.sh — the curl|sh entry point that installation-flow.md
# documents as Phase 1 ("A: curl install.sh" -> "B: SHA-256 checksum OK?" ->
# "C: kb-create binary in ~/.local/bin"), and that no existing test exercises:
# the published V2 e2e journey builds the Go binary in a temporary directory
# with `go build` and skips install.sh entirely.
#
# Runs fully offline by stubbing `curl` (a shim placed first on PATH) so no
# real network or GitHub release is involved. Linux + macOS only, matching
# the project's official support matrix (root CLAUDE.md).
#
# Usage:
#   bash tools/kb-create/install_test.sh
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_SH="$SCRIPT_DIR/install.sh"
# Resolved once, up front, against the real PATH — invoked by absolute path
# below so overriding PATH for install.sh's own tool lookups (curl, uname,
# etc.) doesn't also break finding the bash interpreter that runs it.
SYS_BASH="$(command -v bash)"

PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); printf '✅ %s\n' "$1"; }
fail() {
  FAIL=$((FAIL + 1))
  printf '❌ %s\n' "$1"
  printf '   %s\n' "$2"
}

# ── Fixture binary + checksum content shared by most cases ──────────────────

FAKE_BIN_CONTENT="fake-kb-create-binary-v1"
FAKE_SHA256="$(printf '%s' "$FAKE_BIN_CONTENT" | shasum -a 256 | awk '{print $1}')"

# Reproduce install.sh's own OS/ARCH normalization so BINARY_FILE matches
# exactly what the script under test computes — see install.sh's `case "$ARCH"`
# / `case "$OS"` blocks.
HOST_OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
HOST_ARCH_RAW="$(uname -m)"
case "$HOST_ARCH_RAW" in
  x86_64) HOST_ARCH="amd64" ;;
  aarch64 | arm64) HOST_ARCH="arm64" ;;
  *) HOST_ARCH="$HOST_ARCH_RAW" ;;
esac
BINARY_FILE="kb-create-${HOST_OS}-${HOST_ARCH}"

# write_fake_curl installs a curl shim into $1 that answers install.sh's
# request shapes (stable/canary channel pointer, checksums.txt, the binary
# itself) using the env vars it reads at call time: FAKE_STABLE_TAG,
# FAKE_CANARY_TAG, FAKE_CANARY_MISSING, FAKE_CHECKSUM_LINE, FAKE_BIN_CONTENT.
# Single-quoted heredoc — no expansion at generation time, every value is
# resolved from the environment when the shim actually runs.
write_fake_curl() {
  local dir="$1"
  cat >"$dir/curl" <<'SHIM'
#!/bin/bash
set -e
url=""
outfile=""
args=("$@")
n=${#args[@]}
for ((i = 0; i < n; i++)); do
  case "${args[i]}" in
    -o) outfile="${args[$((i + 1))]}" ;;
    http*) url="${args[i]}" ;;
  esac
done
if [ -n "${FAKE_CURL_LOG:-}" ]; then
  printf '%s\n' "$url" >> "$FAKE_CURL_LOG"
fi
case "$url" in
  *binaries-stable/channel.json*)
    out='{ "schema": 1, "channel": "stable", "tag": "'"${FAKE_STABLE_TAG:-v9.9.9-binaries}"'" }'
    ;;
  *binaries-canary/channel.json*)
    if [ -n "${FAKE_CANARY_MISSING:-}" ]; then
      exit 22
    fi
    out='{ "schema": 1, "channel": "canary", "tag": "'"${FAKE_CANARY_TAG:-v9.9.9-binaries}"'" }'
    ;;
  *checksums.txt)
    out="$FAKE_CHECKSUM_LINE"
    ;;
  *)
    out="$FAKE_BIN_CONTENT"
    ;;
esac
if [ -n "$outfile" ]; then
  printf '%s' "$out" >"$outfile"
else
  printf '%s' "$out"
fi
SHIM
  chmod +x "$dir/curl"
}

# curated_path builds a bin dir with symlinks to every external tool
# install.sh needs, EXCEPT the ones named in $@ — used to simulate "tool
# missing from PATH" (installation-flow.md's hard-fail branches around
# checksum verification).
curated_path() {
  local dir="$1"
  shift
  local exclude=" $* "
  for tool in uname tr grep awk sed head mktemp rm chmod mkdir mv date basename dirname cat sha256sum shasum; do
    case "$exclude" in
      *" $tool "*) continue ;;
    esac
    local real
    real="$(command -v "$tool" 2>/dev/null || true)"
    [ -n "$real" ] && ln -sf "$real" "$dir/$tool"
  done
}

# run_install runs install.sh with a fresh HOME + curated PATH (fake curl
# always included) and captures stdout+stderr and the exit code into globals
# RUN_OUT / RUN_CODE / RUN_HOME.
run_install() {
  RUN_HOME="$(mktemp -d)"
  local fakebin
  fakebin="$(mktemp -d)"
  write_fake_curl "$fakebin"
  local excl="${EXTRA_EXCLUDE:-}"
  curated_path "$fakebin" $excl
  RUN_OUT="$(HOME="$RUN_HOME" PATH="$fakebin" FAKE_STABLE_TAG="${FAKE_STABLE_TAG:-}" \
    FAKE_CANARY_TAG="${FAKE_CANARY_TAG:-}" FAKE_CANARY_MISSING="${FAKE_CANARY_MISSING:-}" \
    FAKE_CHECKSUM_LINE="${FAKE_CHECKSUM_LINE:-}" FAKE_BIN_CONTENT="$FAKE_BIN_CONTENT" \
    "$SYS_BASH" "$INSTALL_SH" "$@" 2>&1)"
  RUN_CODE=$?
}

# ── 1. Success path: checksum matches, binary lands in ~/.local/bin ─────────

test_success_path() {
  FAKE_CHECKSUM_LINE="${FAKE_SHA256}  ${BINARY_FILE}"
  run_install
  if [ "$RUN_CODE" -ne 0 ]; then
    fail "success path" "expected exit 0, got $RUN_CODE. Output:\n$RUN_OUT"
    return
  fi
  local dest="$RUN_HOME/.local/bin/kb-create"
  if [ ! -f "$dest" ]; then
    fail "success path" "binary not found at $dest. Output:\n$RUN_OUT"
    return
  fi
  if [ ! -x "$dest" ]; then
    fail "success path" "binary at $dest is not executable"
    return
  fi
  if [ "$(cat "$dest")" != "$FAKE_BIN_CONTENT" ]; then
    fail "success path" "installed binary content does not match fixture"
    return
  fi
  case "$RUN_OUT" in
    *"Checksum verified"*) ;;
    *) fail "success path" "expected 'Checksum verified' in output:\n$RUN_OUT"; return ;;
  esac
  case "$RUN_OUT" in
    *"Version: v9.9.9-binaries"*) ;;
    *) fail "success path" "installer did not resolve the dedicated binary release tag:\n$RUN_OUT"; return ;;
  esac
  pass "success path: binary installed, executable, checksum verified"
}

# ── 2. Checksum mismatch aborts ─────────────────────────────────────────────

test_checksum_mismatch() {
  FAKE_CHECKSUM_LINE="0000000000000000000000000000000000000000000000000000000000000000  ${BINARY_FILE}"
  run_install
  if [ "$RUN_CODE" -eq 0 ]; then
    fail "checksum mismatch" "expected non-zero exit, got 0. Output:\n$RUN_OUT"
    return
  fi
  case "$RUN_OUT" in
    *"Checksum mismatch"*) ;;
    *) fail "checksum mismatch" "expected 'Checksum mismatch' in output:\n$RUN_OUT"; return ;;
  esac
  if [ -e "$RUN_HOME/.local/bin/kb-create" ]; then
    fail "checksum mismatch" "binary was installed despite mismatch"
    return
  fi
  pass "checksum mismatch: aborts, nothing installed"
}

# ── 3. checksums.txt missing an entry for this binary ───────────────────────

test_missing_checksum_entry() {
  FAKE_CHECKSUM_LINE="${FAKE_SHA256}  some-other-binary-linux-amd64"
  run_install
  if [ "$RUN_CODE" -eq 0 ]; then
    fail "missing checksum entry" "expected non-zero exit, got 0. Output:\n$RUN_OUT"
    return
  fi
  case "$RUN_OUT" in
    *"not found in checksums.txt"*) ;;
    *) fail "missing checksum entry" "expected 'not found in checksums.txt' in output:\n$RUN_OUT"; return ;;
  esac
  pass "missing checksum entry: aborts with a clear message"
}

# ── 4. Neither sha256sum nor shasum on PATH ─────────────────────────────────

test_no_checksum_tool() {
  FAKE_CHECKSUM_LINE="${FAKE_SHA256}  ${BINARY_FILE}"
  EXTRA_EXCLUDE="sha256sum shasum" run_install
  unset EXTRA_EXCLUDE
  if [ "$RUN_CODE" -eq 0 ]; then
    fail "no checksum tool" "expected non-zero exit, got 0. Output:\n$RUN_OUT"
    return
  fi
  case "$RUN_OUT" in
    *"Neither sha256sum nor shasum found"*) ;;
    *) fail "no checksum tool" "expected 'Neither sha256sum nor shasum found' in output:\n$RUN_OUT"; return ;;
  esac
  pass "no checksum tool: aborts with a clear message instead of a raw command-not-found error"
}

# ── 5. Re-running install.sh (idempotency) ──────────────────────────────────

test_idempotent_rerun() {
  FAKE_CHECKSUM_LINE="${FAKE_SHA256}  ${BINARY_FILE}"
  RUN_HOME="$(mktemp -d)"
  local fakebin
  fakebin="$(mktemp -d)"
  write_fake_curl "$fakebin"
  curated_path "$fakebin"

  local out1 code1 out2 code2
  out1="$(HOME="$RUN_HOME" PATH="$fakebin" FAKE_CHECKSUM_LINE="$FAKE_CHECKSUM_LINE" \
    FAKE_BIN_CONTENT="$FAKE_BIN_CONTENT" "$SYS_BASH" "$INSTALL_SH" 2>&1)"
  code1=$?
  out2="$(HOME="$RUN_HOME" PATH="$fakebin" FAKE_CHECKSUM_LINE="$FAKE_CHECKSUM_LINE" \
    FAKE_BIN_CONTENT="$FAKE_BIN_CONTENT" "$SYS_BASH" "$INSTALL_SH" 2>&1)"
  code2=$?

  if [ "$code1" -ne 0 ] || [ "$code2" -ne 0 ]; then
    fail "idempotent re-run" "expected both runs to exit 0, got $code1 / $code2.\nrun1:\n$out1\nrun2:\n$out2"
    return
  fi
  local dest="$RUN_HOME/.local/bin/kb-create"
  if [ "$(cat "$dest" 2>/dev/null)" != "$FAKE_BIN_CONTENT" ]; then
    fail "idempotent re-run" "binary missing or corrupted after second run"
    return
  fi
  # The PATH-export block must not be duplicated across the two runs.
  local zshrc="$RUN_HOME/.zshrc" bashrc="$RUN_HOME/.bashrc" marker_count=0
  for rc in "$zshrc" "$bashrc"; do
    [ -f "$rc" ] || continue
    marker_count=$((marker_count + $(grep -c '# Added by kb-create installer' "$rc" 2>/dev/null || echo 0)))
  done
  if [ "$marker_count" -gt 1 ]; then
    fail "idempotent re-run" "PATH export block duplicated across re-runs (found $marker_count markers)"
    return
  fi
  pass "idempotent re-run: second install.sh run succeeds, no duplicated PATH block"
}

# ── 6. --version pins a specific tag, skipping GitHub API resolution ────────

test_pinned_version() {
  FAKE_CHECKSUM_LINE="${FAKE_SHA256}  ${BINARY_FILE}"
  FAKE_STABLE_TAG="should-not-be-used"
  run_install --version v1.2.3
  unset FAKE_STABLE_TAG
  if [ "$RUN_CODE" -ne 0 ]; then
    fail "pinned version" "expected exit 0, got $RUN_CODE. Output:\n$RUN_OUT"
    return
  fi
  case "$RUN_OUT" in
    *"Channel: pinned (v1.2.3)"*) ;;
    *) fail "pinned version" "expected 'Channel: pinned (v1.2.3)' in output:\n$RUN_OUT"; return ;;
  esac
  pass "pinned version: --version v1.2.3 is used verbatim, no 'latest' resolution"
}

# ── Local candidate download base override ──────────────────────────────────

test_download_base_override() {
  FAKE_CHECKSUM_LINE="$(printf '%s  %s\n%s  release-index.json' "$FAKE_SHA256" "$BINARY_FILE" "$FAKE_SHA256")"
  RUN_HOME="$(mktemp -d)"
  local fakebin log
  fakebin="$(mktemp -d)"
  log="$RUN_HOME/curl.log"
  write_fake_curl "$fakebin"
  curated_path "$fakebin"
  RUN_OUT="$(HOME="$RUN_HOME" PATH="$fakebin" FAKE_CURL_LOG="$log" \
    FAKE_CHECKSUM_LINE="$FAKE_CHECKSUM_LINE" FAKE_BIN_CONTENT="$FAKE_BIN_CONTENT" \
    KB_CREATE_DOWNLOAD_BASE_URL="http://candidate.test/releases" \
    "$SYS_BASH" "$INSTALL_SH" --version journey-candidate 2>&1)"
  RUN_CODE=$?
  if [ "$RUN_CODE" -ne 0 ]; then
    fail "download base override" "expected exit 0, got $RUN_CODE. Output:\n$RUN_OUT"
    return
  fi
  if ! grep -Fq "http://candidate.test/releases/journey-candidate/$BINARY_FILE" "$log" || \
     ! grep -Fq "http://candidate.test/releases/journey-candidate/checksums.txt" "$log" || \
     ! grep -Fq "http://candidate.test/releases/journey-candidate/release-index.json" "$log"; then
    fail "download base override" "installer did not fetch candidate assets from the override. URLs:\n$(cat "$log" 2>/dev/null)"
    return
  fi
  if [ ! -f "$RUN_HOME/.local/share/kb-create/binary-source" ] || [ "$(cat "$RUN_HOME/.local/share/kb-create/binary-source")" != "http://candidate.test/releases" ]; then
    fail "download base override" "verified index did not retain its download source"
    return
  fi
  if [ -e "$RUN_HOME/.local/share/kb-create/bin-dir" ]; then
    fail "download base override" "installer wrote an unused destination record"
    return
  fi
  pass "download base override: pinned binary, checksums and release index use the local origin"
}

# ── 7. --channel defaults to stable ──────────────────────────────────────

test_channel_defaults_to_stable() {
  FAKE_CHECKSUM_LINE="${FAKE_SHA256}  ${BINARY_FILE}"
  FAKE_STABLE_TAG="v1.0.0-binaries"
  FAKE_CANARY_TAG="should-not-be-used"
  run_install
  unset FAKE_STABLE_TAG FAKE_CANARY_TAG
  if [ "$RUN_CODE" -ne 0 ]; then
    fail "channel defaults to stable" "expected exit 0, got $RUN_CODE. Output:\n$RUN_OUT"
    return
  fi
  case "$RUN_OUT" in
    *"Channel: stable (resolved to v1.0.0-binaries)"*) ;;
    *) fail "channel defaults to stable" "expected stable channel resolution in output:\n$RUN_OUT"; return ;;
  esac
  pass "channel defaults to stable: no --channel flag resolves via binaries-stable"
}

# ── 8. --channel canary resolves via the canary pointer ─────────────────────

test_channel_canary() {
  FAKE_CHECKSUM_LINE="${FAKE_SHA256}  ${BINARY_FILE}"
  FAKE_STABLE_TAG="should-not-be-used"
  FAKE_CANARY_TAG="v1.1.0-binaries"
  run_install --channel canary
  unset FAKE_STABLE_TAG FAKE_CANARY_TAG
  if [ "$RUN_CODE" -ne 0 ]; then
    fail "channel canary" "expected exit 0, got $RUN_CODE. Output:\n$RUN_OUT"
    return
  fi
  case "$RUN_OUT" in
    *"Channel: canary (resolved to v1.1.0-binaries)"*) ;;
    *) fail "channel canary" "expected canary channel resolution in output:\n$RUN_OUT"; return ;;
  esac
  pass "channel canary: --channel canary resolves via binaries-canary, not binaries-stable"
}

# ── 9. --version pin skips channel resolution entirely, even with --channel ─

test_pinned_version_ignores_channel() {
  FAKE_CHECKSUM_LINE="${FAKE_SHA256}  ${BINARY_FILE}"
  FAKE_STABLE_TAG="should-not-be-used"
  FAKE_CANARY_TAG="should-not-be-used"
  run_install --version v1.2.3 --channel canary
  unset FAKE_STABLE_TAG FAKE_CANARY_TAG
  if [ "$RUN_CODE" -ne 0 ]; then
    fail "pinned version ignores channel" "expected exit 0, got $RUN_CODE. Output:\n$RUN_OUT"
    return
  fi
  case "$RUN_OUT" in
    *"Channel: pinned (v1.2.3)"*) ;;
    *) fail "pinned version ignores channel" "expected 'Channel: pinned (v1.2.3)' in output:\n$RUN_OUT"; return ;;
  esac
  pass "pinned version ignores channel: --version wins over --channel, no pointer lookup"
}

# ── 10. Unsupported --channel value is rejected before any network call ─────

test_invalid_channel() {
  FAKE_CHECKSUM_LINE="${FAKE_SHA256}  ${BINARY_FILE}"
  run_install --channel bogus
  if [ "$RUN_CODE" -eq 0 ]; then
    fail "invalid channel" "expected non-zero exit, got 0. Output:\n$RUN_OUT"
    return
  fi
  case "$RUN_OUT" in
    *"Unsupported channel: bogus"*) ;;
    *) fail "invalid channel" "expected 'Unsupported channel: bogus' in output:\n$RUN_OUT"; return ;;
  esac
  pass "invalid channel: rejected with a clear error before resolving 'latest'"
}

# ── 11. --channel requires a value ───────────────────────────────────────────

test_channel_missing_value() {
  run_install --channel
  if [ "$RUN_CODE" -eq 0 ]; then
    fail "--channel missing value" "expected non-zero exit, got 0. Output:\n$RUN_OUT"
    return
  fi
  case "$RUN_OUT" in
    *"--channel requires a value"*) ;;
    *) fail "--channel missing value" "expected '--channel requires a value' in output:\n$RUN_OUT"; return ;;
  esac
  pass "--channel missing value: rejected with a clear error"
}

# ── 12. Canary pointer release absent -> clear resolution failure ───────────

test_canary_pointer_missing() {
  FAKE_CHECKSUM_LINE="${FAKE_SHA256}  ${BINARY_FILE}"
  FAKE_CANARY_MISSING=1
  run_install --channel canary
  unset FAKE_CANARY_MISSING
  if [ "$RUN_CODE" -eq 0 ]; then
    fail "canary pointer missing" "expected non-zero exit, got 0. Output:\n$RUN_OUT"
    return
  fi
  case "$RUN_OUT" in
    *"Unable to resolve the canary binaries channel"*) ;;
    *) fail "canary pointer missing" "expected canary resolution error in output:\n$RUN_OUT"; return ;;
  esac
  pass "canary pointer missing: aborts with a clear message instead of a raw curl error"
}

# ── 13. -h/--help and unknown-argument handling ─────────────────────────────

test_help_flag() {
  run_install --help
  if [ "$RUN_CODE" -ne 0 ]; then
    fail "--help" "expected exit 0, got $RUN_CODE"
    return
  fi
  case "$RUN_OUT" in
    *"Usage: install.sh"*) ;;
    *) fail "--help" "expected usage text in output:\n$RUN_OUT"; return ;;
  esac
  pass "--help: prints usage, exits 0"
}

test_unknown_argument() {
  run_install --bogus-flag
  if [ "$RUN_CODE" -eq 0 ]; then
    fail "unknown argument" "expected non-zero exit, got 0"
    return
  fi
  case "$RUN_OUT" in
    *"unknown argument"*) ;;
    *) fail "unknown argument" "expected 'unknown argument' in output:\n$RUN_OUT"; return ;;
  esac
  pass "unknown argument: rejected with a clear error"
}

test_download_source_rejects_credentials() {
  local tmp_home fakebin output exit_code
  tmp_home="$(mktemp -d)"; fakebin="$(mktemp -d)"
  write_fake_curl "$fakebin"; curated_path "$fakebin"
  output="$(HOME="$tmp_home" PATH="$fakebin" FAKE_BIN_CONTENT="$FAKE_BIN_CONTENT" FAKE_CHECKSUM_LINE="${FAKE_SHA256}  ${BINARY_FILE}" KB_CREATE_DOWNLOAD_BASE_URL="http://user:secret-password@candidate.test" "$SYS_BASH" "$INSTALL_SH" --version journey-candidate 2>&1)"; exit_code=$?
  if [ "$exit_code" -eq 0 ] || [ -e "$tmp_home/.local/share/kb-create/binary-source" ]; then fail "credential source" "installer accepted and recorded URL credentials"; return; fi
  case "$output" in *secret-password*) fail "credential source" "installer disclosed URL credentials"; return;; esac
  pass "credential source: credentials refused without disclosure"
}

test_xdg_saved_index() {
  local data
  data="$(mktemp -d)"
  FAKE_CHECKSUM_LINE="$(printf '%s  %s\n%s  release-index.json' "$FAKE_SHA256" "$BINARY_FILE" "$FAKE_SHA256")"
  XDG_DATA_HOME="$data" run_install --version v1.2.3
  if [ "$RUN_CODE" -ne 0 ] || [ ! -f "$data/kb-create/release-index.json" ] || [ ! -f "$data/kb-create/binary-source" ]; then
    fail "XDG launcher data" "index and source not saved under XDG_DATA_HOME: $RUN_OUT"
    return
  fi
  pass "XDG launcher data: saved index and source share the requested directory"
}

# ── run everything ───────────────────────────────────────────────────────────

if [ ! -f "$INSTALL_SH" ]; then
  echo "install.sh not found at $INSTALL_SH" >&2
  exit 1
fi

case "$(uname -s)" in
  Darwin | Linux) ;;
  *)
    echo "install_test.sh only runs on Linux/macOS (official support matrix)." >&2
    exit 1
    ;;
esac

test_success_path
test_xdg_saved_index
test_download_base_override
test_download_source_rejects_credentials
test_checksum_mismatch
test_missing_checksum_entry
test_no_checksum_tool
test_idempotent_rerun
test_pinned_version
test_channel_defaults_to_stable
test_channel_canary
test_pinned_version_ignores_channel
test_invalid_channel
test_channel_missing_value
test_canary_pointer_missing
test_help_flag
test_unknown_argument

echo ""
echo "── install.sh test summary ──"
echo "  passed: $PASS"
echo "  failed: $FAIL"

[ "$FAIL" -eq 0 ]
