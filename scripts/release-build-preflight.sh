#!/usr/bin/env bash
# Local reproduction for the release build used by PR CI and candidate builds.
# Requires Node 24, pnpm dependencies already installed, and Go 1.26. Run:
#   bash scripts/release-build-preflight.sh platform canary "$(git rev-parse HEAD)" preflight
# Candidate workflow form:
#   bash scripts/release-build-preflight.sh <flow> <channel> <commit-sha> <candidate|preflight> [expected-version]
set -euo pipefail

if [[ $# -lt 4 || $# -gt 5 ]]; then
  echo 'Usage: bash scripts/release-build-preflight.sh <flow> <channel> <commit-sha> <candidate|preflight> [expected-version]' >&2
  exit 2
fi

flow="$1"
channel="$2"
commit_sha="$3"
mode="$4"
expected_version="${5:-}"

if [[ "$mode" != candidate && "$mode" != preflight ]]; then
  echo "Unknown release build mode '$mode'; use candidate or preflight." >&2
  exit 2
fi
if [[ "$mode" == candidate && -z "$expected_version" ]]; then
  echo 'Candidate mode requires the expected release version.' >&2
  exit 2
fi
if [[ "$mode" == preflight && "$channel" != canary ]]; then
  echo 'Preflight mode requires the canary channel so package versions remain disposable.' >&2
  exit 2
fi
if [[ ! "$commit_sha" =~ ^[0-9a-fA-F]{9,40}$ ]]; then
  echo 'Commit SHA must contain 9 to 40 hexadecimal characters.' >&2
  exit 2
fi

adapters="$(node -e '
  const fs = require("node:fs");
  const lock = JSON.parse(fs.readFileSync(".kb/marketplace.lock", "utf8"));
  process.stdout.write(Object.entries(lock.adapters ?? {}).filter(([, entry]) => entry.enabled).map(([name]) => name).sort().join(","));
')"
packages="@kb-labs/cli-bin,@kb-labs/release"
if [[ -n "$adapters" ]]; then
  packages="$packages,$adapters"
fi
./tools/kb-devkit/kb-devkit run build --packages "$packages" --no-cache

node ./cli/bin/dist/bin.js release plan \
  --flow "$flow" --channel "$channel" --bump auto --json

node --input-type=module - "$flow" "$channel" "$commit_sha" "$mode" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';

const [flow, channel, commitSha, mode] = process.argv.slice(2);
const root = process.cwd();
const planPath = path.join(root, '.kb', 'release', 'plans', 'root', 'current', 'plan.json');
const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
if (plan.flow !== flow || plan.channel !== channel) {
  throw new Error(`regenerated release plan does not match requested flow/channel: ${plan.flow}/${plan.channel}`);
}

const short = commitSha.slice(0, 9);
if (channel === 'canary') {
  for (const item of plan.packages) {
    if (item.nextVersion.includes('-canary.')) {
      const suffix = mode === 'preflight' ? `-preflight.${short}` : `-canary.${short}`;
      item.nextVersion = item.nextVersion.replace(/-canary\.[^.]+$/, suffix);
    }
  }
}

const packages = new Map();
const walk = directory => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(target);
    else if (entry.name === 'package.json') {
      const manifest = JSON.parse(fs.readFileSync(target, 'utf8'));
      if (manifest.name) packages.set(manifest.name, path.dirname(target));
    }
  }
};
walk(root);
for (const item of plan.packages) {
  const packagePath = packages.get(item.name);
  if (!packagePath) throw new Error(`release plan package is absent from candidate workspace: ${item.name}`);
  item.path = packagePath;
}
fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
NODE

if [[ "$mode" == candidate && "$channel" == stable ]]; then
  EXPECTED_VERSION="$expected_version" node --input-type=module <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
const plan = JSON.parse(fs.readFileSync('.kb/release/plans/root/current/plan.json', 'utf8'));
const expected = process.env.EXPECTED_VERSION;
const mismatches = [];
for (const pkg of plan.packages) {
  const pkgJsonPath = path.join(pkg.path, 'package.json');
  const onDisk = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')).version;
  if (onDisk !== expected) mismatches.push(`${pkg.name}: ${onDisk} (expected ${expected})`);
}
if (mismatches.length > 0) {
  throw new Error(
    `stable candidate commit is not already versioned at ${expected} — release-prepare's ` +
    '"Bump versions"/"Commit and tag" steps should have applied this before dispatch:\n' +
    mismatches.join('\n'),
  );
}
console.log(`Verified ${plan.packages.length} package(s) already at ${expected}; skipping re-bump.`);
NODE
else
  node ./cli/bin/dist/bin.js release version update \
    --flow "$flow" --channel "$channel" --json
fi

node ./cli/bin/dist/bin.js release build run --flow "$flow" --json
