#!/usr/bin/env bash
set -euo pipefail
umask 077
work="$(mktemp -d "${RUNNER_TEMP:?}/canary-delivery.XXXXXXXX")"
trap 'rm -rf "$work"' EXIT
log="$work/stage.log"
fail() {
  local stage="$1" status="$2"
  printf 'Canary %s failed (exit %s). Diagnostic tail:\n' "$stage" "$status" >&2
  node - "$log" <<'NODE'
const fs = require('fs');
let text = fs.readFileSync(process.argv[2], 'utf8');
for (const key of ['NPM_TOKEN', 'NODE_AUTH_TOKEN', 'CANARY_RELEASES_SSH_KEY', 'CANARY_RELEASES_KNOWN_HOSTS']) {
  const secret = process.env[key];
  if (secret) for (const part of [secret, ...secret.split(/\r?\n/).filter(s => s.length >= 8)]) text = text.split(part).join('[redacted]');
}
process.stderr.write(text.slice(-2000) + '\n');
NODE
  exit "$status"
}
run_stage() {
  local stage="$1"; shift
  : > "$log"
  "$@" > "$log" 2>&1 || fail "$stage" "$?"
}
for name in NPM_TOKEN CANARY_RELEASES_SSH_KEY CANARY_RELEASES_KNOWN_HOSTS CANDIDATE_ID COMMIT_SHA FLOW CHANNEL VERSION; do
  if [[ -z "${!name:-}" ]]; then printf 'Canary setup failed: missing %s.\n' "$name" >&2; exit 1; fi
done
if [[ "$CHANNEL" != canary ]]; then
  printf 'Canary setup failed: deliver_canary requires channel canary.\n' >&2
  exit 1
fi
printf '%s\n' "$CANARY_RELEASES_SSH_KEY" > "$work/key"
printf '%s\n' "$CANARY_RELEASES_KNOWN_HOSTS" > "$work/known_hosts"
chmod 600 "$work/key" "$work/known_hosts"
export RSYNC_RSH="ssh -i $work/key -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$work/known_hosts"
remote='kb-releases@releases.kblabs.ru:./'
bundle='.kb/release/bundle'
digest="$(node -e 'const p=require("./.kb/release/bundle/provenance.json"); if (!p.bundleDigest) process.exit(1); process.stdout.write(p.bundleDigest)')"
tag="v${VERSION}-binaries"
run_stage publish timeout 20m node ./cli/bin/dist/bin.js release artifact publish --flow "$FLOW" --bundle-dir "$bundle" --expected-digest "$digest" --candidate-id "$CANDIDATE_ID" --commit "$COMMIT_SHA" --version "$VERSION" --target canary --json --yes
run_stage 'remote listing' rsync --list-only "$remote"
cp "$log" "$work/listing"
if awk '{print $NF}' "$work/listing" | grep -Fx 'binaries-canary' >/dev/null; then
  run_stage 'pointer read' rsync "${remote}binaries-canary/channel.json" "$work/previous.json"
else
  printf '{"history":[]}\n' > "$work/previous.json"
fi
run_stage staging node scripts/canary-delivery.mjs "$bundle" "$work/staged" "$tag" "$CANDIDATE_ID" "$work/previous.json"
if awk '{print $NF}' "$work/listing" | grep -Fx "$tag" >/dev/null; then
  printf 'Canary upload failed: version directory already exists: %s\n' "$tag" >&2
  exit 1
fi
run_stage upload rsync -r --chmod=D755,F644 "$work/staged/$tag" "$remote"
mkdir "$work/empty"
node -e 'const fs=require("fs"); for (const v of JSON.parse(fs.readFileSync(process.argv[1]))) console.log(v)' "$work/staged/remove.json" > "$work/remove"
while IFS= read -r old; do
  [[ -n "$old" ]] || continue
  run_stage retention rsync -r --delete --chmod=D755,F644 --include="/$old/***" --exclude='*' "$work/empty/" "$remote"
done < "$work/remove"
run_stage 'pointer update' rsync -r --chmod=D755,F644 "$work/staged/binaries-canary" "$remote"
printf 'Canary delivery completed: %s\n' "$tag"
