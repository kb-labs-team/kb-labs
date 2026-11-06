#!/bin/sh
set -eu

REPO="kb-labs-team/kb-labs"
BINARY="kb-create"
# Override only the release download origin (for local candidate testing).
# Unset, public installs continue to download from GitHub Releases.
DOWNLOAD_BASE_URL="${KB_CREATE_DOWNLOAD_BASE_URL:-https://github.com/${REPO}/releases/download}"
DEST="${HOME}/.local/bin/${BINARY}"
INDEX_DEST="${XDG_DATA_HOME:-${HOME}/.local/share}/${BINARY}/release-index.json"
VERSION="latest"
CHANNEL="stable"
RESOLVED_VERSION=""
START_TS="$(date +%s)"

# BEGIN GENERATED COLOR POLICY
kb_color_enabled() {
  if [ -n "${NO_COLOR:-}" ]; then return 1; fi
  if [ "${FORCE_COLOR+x}" = x ] && { [ "$FORCE_COLOR" = false ] || [ "$FORCE_COLOR" = 0 ]; }; then return 1; fi
  if [ "${FORCE_COLOR+x}" = x ]; then
    case "$FORCE_COLOR" in
      ''|true) return 0 ;;
      false|0) ;;
      *)
        case "$FORCE_COLOR" in *[!0123456789]*) ;;
          *) case "$FORCE_COLOR" in *[123456789]*) return 0 ;; esac ;;
        esac
        ;;
    esac
  fi
  case "${TERM:-}" in [Dd][Uu][Mm][Bb]) return 1 ;; esac
  if [ -t 1 ]; then return 0; fi
  return 1
}
# END GENERATED COLOR POLICY
if kb_color_enabled; then
  C_RESET="$(printf '\033[0m')"
  C_BOLD="$(printf '\033[1m')"
  C_DIM="$(printf '\033[2m')"
  C_CYAN="$(printf '\033[36m')"
  C_GREEN="$(printf '\033[32m')"
  C_YELLOW="$(printf '\033[33m')"
  C_RED="$(printf '\033[31m')"
else
  C_RESET=""
  C_BOLD=""
  C_DIM=""
  C_CYAN=""
  C_GREEN=""
  C_YELLOW=""
  C_RED=""
fi

info() { printf "%s[INFO]%s %s\n" "$C_CYAN" "$C_RESET" "$1"; }
ok() { printf "%s[ OK ]%s %s\n" "$C_GREEN" "$C_RESET" "$1"; }
warn() { printf "%s[WARN]%s %s\n" "$C_YELLOW" "$C_RESET" "$1"; }
err() { printf "%s[ERR ]%s %s\n" "$C_RED" "$C_RESET" "$1" >&2; }

# The source is recorded as provenance; do not persist URL userinfo.
case "$DOWNLOAD_BASE_URL" in
  *://*)
    source_authority=${DOWNLOAD_BASE_URL#*://}
    source_authority=${source_authority%%/*}
    case "$source_authority" in *@*) err "The binary source URL must not contain credentials."; exit 1;; esac
    ;;
esac

# BEGIN GENERATED UNSUPPORTED PLATFORM
kb_unsupported_platform() {
  platform_os="$1"
  platform_arch="$2"
  err "$(printf 'KB_INSTALL_UNSUPPORTED_PLATFORM: %s/%s is not a supported platform.' "$platform_os" "$platform_arch")"
  err "$(printf '%s' 'Run the same command on a supported Linux or macOS system.')"
  exit 1
}
# END GENERATED UNSUPPORTED PLATFORM

usage() {
  cat <<'EOF'
Usage: install.sh [--version <tag>] [--channel <stable|canary>]

Options:
  --version <tag>       Install specific release tag (example: v1.2.3-binaries)
  --channel <name>      Channel to resolve "latest" from: stable or canary (default: stable)
  -h, --help            Show this help
EOF
}

print_banner() {
  cat <<'EOF'
  _    _  ____    _          _           
 | | _| || __ )  | |    __ _| |__  ___   
 | |/ / ||  _ \  | |   / _` | '_ \/ __|  
 |   <| || |_) | | |__| (_| | |_) \__ \  
 |_|\_\_||____/  |_____\__,_|_.__/|___/  

EOF
  printf "%sKB Labs Launcher installer%s\n" "$C_BOLD" "$C_RESET"
  echo ""
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      shift
      if [ "$#" -eq 0 ]; then
        echo "Error: --version requires a value (example: v1.2.3)." >&2
        exit 1
      fi
      VERSION="$1"
      ;;
    --channel)
      shift
      if [ "$#" -eq 0 ]; then
        echo "Error: --channel requires a value (stable or canary)." >&2
        exit 1
      fi
      CHANNEL="$1"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Error: unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

if ! command -v curl >/dev/null 2>&1; then
  err "curl is required but not found in PATH."
  exit 1
fi

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$ARCH" in
  x86_64) ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *)
    err "Unsupported architecture: $ARCH"
    exit 1
    ;;
esac

case "$OS" in
  darwin|linux) ;;
  mingw*|msys*|cygwin*) kb_unsupported_platform windows "$ARCH" ;;
  *)
    err "Unsupported OS: $OS"
    exit 1
    ;;
esac

case "$CHANNEL" in
  stable|canary) ;;
  *)
    err "Unsupported channel: $CHANNEL (expected stable or canary)"
    exit 1
    ;;
esac

if [ "$VERSION" = "latest" ]; then
  # `binaries-stable`/`binaries-canary` are tiny mutable GitHub Release assets
  # maintained by the workflow-engine release delivery path. Resolve it from
  # the same origin as the versioned assets.
  CHANNEL_JSON="$(curl -fsSL "${DOWNLOAD_BASE_URL}/binaries-${CHANNEL}/channel.json" 2>/dev/null)" || {
    err "Unable to resolve the ${CHANNEL} binaries channel from the configured download base."
    exit 1
  }
  RESOLVED_VERSION="$(printf '%s\n' "$CHANNEL_JSON" | sed -n 's/.*"tag":[[:space:]]*"\([^"]*-binaries\)".*/\1/p' | head -n 1)"
  if [ -z "$RESOLVED_VERSION" ]; then
    err "No binary release was found for ${REPO}."
    exit 1
  fi
  BASE_URL="${DOWNLOAD_BASE_URL}/${RESOLVED_VERSION}"
else
  RESOLVED_VERSION="$VERSION"
  BASE_URL="${DOWNLOAD_BASE_URL}/${RESOLVED_VERSION}"
fi

BINARY_FILE="${BINARY}-${OS}-${ARCH}"
BINARY_URL="${BASE_URL}/${BINARY_FILE}"
CHECKSUMS_URL="${BASE_URL}/checksums.txt"

print_banner
info "Repository: ${REPO}"
if [ "$VERSION" = "latest" ]; then
  if [ -n "$RESOLVED_VERSION" ]; then
    info "Channel: ${CHANNEL} (resolved to ${RESOLVED_VERSION})"
  else
    info "Channel: ${CHANNEL} (GitHub latest/download)"
  fi
else
  info "Channel: pinned (${RESOLVED_VERSION})"
fi
info "Target: ${OS}/${ARCH}  ->  ${BINARY_FILE}"
echo ""

TMP_BIN="$(mktemp)"
TMP_SUM="$(mktemp)"
cleanup() {
  rm -f "$TMP_BIN" "$TMP_SUM"
}
trap cleanup EXIT

info "Downloading ${BINARY_FILE}..."
curl -fsSL "$BINARY_URL" -o "$TMP_BIN"

info "Downloading checksums..."
curl -fsSL "$CHECKSUMS_URL" -o "$TMP_SUM"

EXPECTED="$(grep "  ${BINARY_FILE}$" "$TMP_SUM" | awk '{print $1}' | head -n 1)"
if [ -z "$EXPECTED" ]; then
  err "Checksum for ${BINARY_FILE} not found in checksums.txt."
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL="$(sha256sum "$TMP_BIN" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  ACTUAL="$(shasum -a 256 "$TMP_BIN" | awk '{print $1}')"
else
  err "Neither sha256sum nor shasum found for checksum verification."
  exit 1
fi

if [ "$EXPECTED" != "$ACTUAL" ]; then
  err "Checksum mismatch for ${BINARY_FILE}."
  err "Expected: $EXPECTED"
  err "Actual:   $ACTUAL"
  exit 1
fi

chmod +x "$TMP_BIN"
mkdir -p "$(dirname "$DEST")"
mv "$TMP_BIN" "$DEST"
mkdir -p "$(dirname "$INDEX_DEST")"

# The launcher resolves installs from this signed index, never by talking to
# npm directly. It ships next to the binary on the same immutable per-version
# GitHub Release, verified with the same checksums.txt as the binary above —
# not every candidate is required to publish one (release-index.json is
# platform-flow only), so a missing file is a soft skip, not a fatal error.
INDEX_URL="${BASE_URL}/release-index.json"
TMP_INDEX="$(mktemp)"
if curl -fsSL "$INDEX_URL" -o "$TMP_INDEX" 2>/dev/null; then
  EXPECTED_INDEX="$(grep '  release-index.json$' "$TMP_SUM" | awk '{print $1}' | head -n 1)"
  if [ -n "$EXPECTED_INDEX" ]; then
    if command -v sha256sum >/dev/null 2>&1; then
      ACTUAL_INDEX="$(sha256sum "$TMP_INDEX" | awk '{print $1}')"
    else
      ACTUAL_INDEX="$(shasum -a 256 "$TMP_INDEX" | awk '{print $1}')"
    fi
    if [ "$EXPECTED_INDEX" != "$ACTUAL_INDEX" ]; then
      err "Checksum mismatch for release-index.json."
      err "Expected: $EXPECTED_INDEX"
      err "Actual:   $ACTUAL_INDEX"
      rm -f "$TMP_INDEX"
      exit 1
    fi
    mkdir -p "$(dirname "$INDEX_DEST")"
    mv "$TMP_INDEX" "$INDEX_DEST"
    (umask 077; printf '%s\n' "$DOWNLOAD_BASE_URL" > "$(dirname "$INDEX_DEST")/binary-source")
    chmod 600 "$(dirname "$INDEX_DEST")/binary-source"
  else
    rm -f "$TMP_INDEX"
    INDEX_DEST=""
  fi
else
  rm -f "$TMP_INDEX"
  INDEX_DEST=""
fi

ensure_path() {
  # Already in current shell's PATH? Nothing to do.
  case ":$PATH:" in
    *":${HOME}/.local/bin:"*) return 0 ;;
  esac

  # Pick the user's shell profile. Prefer the one matching $SHELL.
  shell_name="$(basename "${SHELL:-}")"
  case "$shell_name" in
    zsh)  profile="${HOME}/.zshrc" ;;
    bash) profile="${HOME}/.bashrc" ;;
    *)
      # Fallback: prefer .zshrc if it exists (macOS default), else .bashrc.
      if [ -f "${HOME}/.zshrc" ]; then profile="${HOME}/.zshrc"
      else profile="${HOME}/.bashrc"; fi
      ;;
  esac

  export_line='export PATH="$HOME/.local/bin:$PATH"'
  marker='# Added by kb-create installer'

  # If already recorded in the profile, just remind the user to reload.
  if [ -f "$profile" ] && grep -Fq "$export_line" "$profile" 2>/dev/null; then
    echo ""
    warn "~/.local/bin is in $profile but not yet loaded in this shell."
    printf "  Run: %ssource %s%s\n" "$C_DIM" "$profile" "$C_RESET"
    printf "  Or open a new terminal window.\n"
    return 0
  fi

  # Append PATH export to the chosen profile.
  {
    echo ""
    echo "$marker"
    echo "$export_line"
  } >> "$profile"

  echo ""
  ok "Added ~/.local/bin to PATH via $profile"
  printf "  To use kb-create in this shell, run: %ssource %s%s\n" "$C_DIM" "$profile" "$C_RESET"
  printf "  Or open a new terminal window.\n"
}

ensure_path

END_TS="$(date +%s)"
ELAPSED="$((END_TS - START_TS))"

echo ""
ok "${BINARY} installed to $DEST"
ok "Checksum verified (${BINARY_FILE})"
if [ -n "$RESOLVED_VERSION" ]; then
  ok "Version: ${RESOLVED_VERSION}"
else
  ok "Version: latest"
fi
ok "Installation completed in ${ELAPSED}s"
if [ -n "$INDEX_DEST" ]; then
  ok "Release index verified and saved to $INDEX_DEST"
fi
echo ""
printf "%sGet started:%s\n" "$C_BOLD" "$C_RESET"
printf "  %skb-create install%s\n" "$C_DIM" "$C_RESET"
