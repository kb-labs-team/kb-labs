#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CANDIDATE_DIR="${1:?usage: pty-procfs-artifact-smoke.sh <downloaded-candidate-artifact> }"
ARCHIVE="$CANDIDATE_DIR/shared/build-candidate.tar"
[[ -r "$ARCHIVE" ]] || { echo "candidate build archive is missing" >&2; exit 1; }

wizard_binary="$(mktemp "${TMPDIR:-/tmp}/journey-pty-installed-wizard.XXXXXX")"
release_index="$(mktemp "${TMPDIR:-/tmp}/journey-pty-installed-index.XXXXXX")"
trap 'rm -f "$wizard_binary" "$release_index"' EXIT

tar -xOf "$ARCHIVE" ./.journey/release/journey-candidate/kb-create-linux-amd64 > "$wizard_binary"
tar -xOf "$ARCHIVE" ./.journey/release/journey-candidate/release-index.json > "$release_index"
chmod 0755 "$wizard_binary"

export KB_JOURNEY_PTY_WIZARD_MODE=installed
export KB_JOURNEY_PTY_WIZARD_BINARY="$wizard_binary"
export KB_JOURNEY_PTY_RELEASE_INDEX="$release_index"
bash "$ROOT/e2e/journey/pty-procfs-smoke.sh"
