#!/usr/bin/env bash
# check-pack-install.sh
# Pack the package with pnpm's publish materialization and verify:
#   1. The tarball is produced (using pnpm's publish materialization)
#   2. All declared exports paths exist inside the tarball
#   3. The main entry file is valid JavaScript (node --check)
#
# CWD: package directory (set by release manager check runner)
# Exit 0 = pass, 1 = fail

set -euo pipefail

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

PKG_JSON="package.json"

if [[ ! -f "$PKG_JSON" ]]; then
  echo "ERROR: package.json not found in $(pwd)" >&2
  exit 1
fi

PKG_NAME=$(node -e "process.stdout.write(require('./package.json').name || '')")

echo "Packing $PKG_NAME..."
TARBALL_OUTPUT=$(pnpm pack --pack-destination "$WORK_DIR" --silent 2>/dev/null | tail -1)
TARBALL_PATH="$TARBALL_OUTPUT"
if [[ ! -f "$TARBALL_PATH" ]]; then
  TARBALL_PATH="$WORK_DIR/$(basename "$TARBALL_OUTPUT")"
fi
TARBALL=$(basename "$TARBALL_PATH")

if [[ ! -f "$TARBALL_PATH" ]]; then
  echo "ERROR: package pack did not produce a tarball" >&2
  exit 1
fi

echo "Extracting $TARBALL..."
tar -xzf "$TARBALL_PATH" -C "$WORK_DIR"

EXTRACTED="$WORK_DIR/package"

# A package can pass exports and syntax checks while still being impossible
# to install outside the workspace. Inspect the packed manifest because this
# is the artifact a user receives, not the source package.json.
if ! node - "$EXTRACTED/package.json" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
const issues = [];
for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
  for (const [name, value] of Object.entries(pkg[section] || {})) {
    if (typeof value !== 'string') continue;
    if (/^(workspace:|link:|file:)/.test(value)) {
      issues.push(`${section}.${name}=${value}`);
    }
  }
}
if (issues.length) {
  console.error(`ERROR: packed manifest contains workspace-only dependency protocols:\n  ${issues.join('\n  ')}`);
  process.exit(1);
}
NODE
then
  exit 1
fi

# Collect all entry points declared in package.json
ENTRIES=$(node -e "
  const p = require('./package.json');
  const entries = new Set();

  // main / module
  if (p.main) entries.add(p.main);
  if (p.module) entries.add(p.module);

  // exports map — collect all leaf string values
  function walk(obj) {
    if (typeof obj === 'string') { entries.add(obj); return; }
    if (obj && typeof obj === 'object') { Object.values(obj).forEach(walk); }
  }
  if (p.exports) walk(p.exports);

  // types
  if (p.types) entries.add(p.types);
  if (p.typings) entries.add(p.typings);

  // filter to files that should exist (skip conditions like 'import', 'require', 'types')
  const files = [...entries].filter(e =>
    typeof e === 'string' &&
    (e.startsWith('./') || e.startsWith('dist/')) &&
    !e.includes('*')
  );
  process.stdout.write(files.join('\n'));
")

FAILED=0
while IFS= read -r ENTRY; do
  [[ -z "$ENTRY" ]] && continue
  # Strip leading ./
  REL="${ENTRY#./}"
  FULL="$EXTRACTED/$REL"
  if [[ ! -f "$FULL" ]] && [[ ! -d "$FULL" ]]; then
    echo "ERROR: declared entry '$ENTRY' missing from packed tarball" >&2
    FAILED=1
  else
    echo "  OK: $ENTRY"
  fi
done <<< "$ENTRIES"

if [[ $FAILED -eq 1 ]]; then
  echo "" >&2
  echo "Packed files:" >&2
  find "$EXTRACTED" -type f | sed "s|$EXTRACTED/||" | sort >&2
  exit 1
fi

# Syntax-check the main JS entry
MAIN_ENTRY=$(node -e "
  const p = require('./package.json');
  const entry = p.exports?.['.']?.import ?? p.exports?.['.']?.require ?? p.main ?? 'dist/index.js';
  process.stdout.write(entry.replace(/^\.\//, ''));
")

MAIN_FULL="$EXTRACTED/$MAIN_ENTRY"
if [[ -f "$MAIN_FULL" ]]; then
  echo "Syntax-checking $MAIN_ENTRY..."
  if ! node --check "$MAIN_FULL" 2>&1; then
    echo "ERROR: $MAIN_ENTRY failed syntax check" >&2
    exit 1
  fi
  echo "  OK: syntax valid"
fi

# If a release plan is in scope (RELEASE_PLAN_PATH — set by the
# release-prepare workflow's staging step, before this flow's Bump versions
# step has run), the tarball above still declares internal-sibling
# dependencies pinned to their CURRENT, already-published version: `pnpm
# pack` materializes `workspace:*` as the exact on-disk version, and at this
# point in the workflow that's still the pre-bump version (see the file
# header). Rewrite those specific deps to the plan's PLANNED nextVersion so
# the clean-install below actually exercises the API surface this release is
# about to ship — which the staging step has published to a local registry —
# instead of re-verifying whatever is already live on npm.
INSTALL_TARBALL_PATH="$TARBALL_PATH"
STAGING_REGISTRY=""

if [[ -n "${RELEASE_PLAN_PATH:-}" ]]; then
  if [[ ! -f "$RELEASE_PLAN_PATH" ]]; then
    echo "ERROR: RELEASE_PLAN_PATH is set to '$RELEASE_PLAN_PATH' but that file does not exist" >&2
    exit 1
  fi

  STAGING_REGISTRY="${KB_RELEASE_STAGING_REGISTRY:-http://localhost:4873}"

  echo "Checking staging registry at $STAGING_REGISTRY..."
  if ! curl -fsS --max-time 5 "$STAGING_REGISTRY/-/ping" >/dev/null 2>&1; then
    echo "" >&2
    echo "ERROR: local staging registry unreachable at $STAGING_REGISTRY" >&2
    echo "  pack-install needs the release plan's packages staged there first." >&2
    echo "  Run: ./tools/kb-dev/kb-dev ensure verdaccio --config .kb/devservices.dev.yaml --net-offset ${KB_NET_OFFSET:-0}" >&2
    echo "  Then re-run the staging step before Checks." >&2
    exit 1
  fi

  node - "$EXTRACTED/package.json" "$RELEASE_PLAN_PATH" <<'NODE'
const fs = require('node:fs');
const [, , pkgFile, planFile] = process.argv;
const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
const nextVersions = new Map((plan.packages || []).map((p) => [p.name, p.nextVersion]));
let modified = false;
for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
  const deps = pkg[section];
  if (!deps) continue;
  for (const name of Object.keys(deps)) {
    const nextVersion = nextVersions.get(name);
    const pinned = `^${nextVersion}`;
    if (nextVersion && deps[name] !== pinned) {
      deps[name] = pinned;
      modified = true;
    }
  }
}
if (modified) {
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
  console.log('  Rewrote internal sibling deps to planned versions.');
}
NODE

  STAGED_TARBALL="$WORK_DIR/staged-$TARBALL"
  tar -czf "$STAGED_TARBALL" -C "$WORK_DIR" package
  INSTALL_TARBALL_PATH="$STAGED_TARBALL"
fi

# Install the actual tarball into an empty consumer project. This catches
# unresolved workspace/link/file dependencies AND already-published peer
# dependencies that are themselves broken (npm auto-installs peers, so a bad
# manifest several levels deep in someone else's graph breaks this install
# too — static checks above can't see that).
#
# Delegates to `release clean install` (same implementation `release
# stage` uses for its own final check) instead of shelling to `npm install`
# directly: plain npm swallows this exact failure class (EUNSUPPORTEDPROTOCOL
# thrown deep inside its own Arborist dependency resolver) as an unhandled
# rejection and prints nothing beyond "npm error, see log file" — confirmed
# live chasing @kb-labs/sdk@2.115.0's install failure, which took a manual
# Arborist repro to actually diagnose. Calling Arborist ourselves gets the
# real error message instead.
REPO_ROOT=$(git rev-parse --show-toplevel)
CLI_BIN="$REPO_ROOT/cli/bin/dist/bin.js"
echo "Installing packed artifact into a clean consumer..."
if [[ -f "$CLI_BIN" ]]; then
  CLEAN_INSTALL_ARGS=(release clean install --tarball "$INSTALL_TARBALL_PATH" --name "$PKG_NAME")
  if [[ -n "$STAGING_REGISTRY" ]]; then
    CLEAN_INSTALL_ARGS+=(--registry "$STAGING_REGISTRY")
  fi
  if ! node "$CLI_BIN" "${CLEAN_INSTALL_ARGS[@]}"; then
    exit 1
  fi
else
  # Fallback for contexts where the CLI hasn't been built (e.g. this script
  # invoked standalone, outside the release checks run pipeline) — same checks,
  # degraded (unexplained) error message on failure.
  CONSUMER="$WORK_DIR/consumer"
  mkdir -p "$CONSUMER"
  printf '{"name":"kb-release-consumer","private":true}\n' > "$CONSUMER/package.json"
  if [[ -n "$STAGING_REGISTRY" ]]; then
    printf 'registry=%s\n' "$STAGING_REGISTRY" > "$CONSUMER/.npmrc"
  fi
  if ! npm install --prefix "$CONSUMER" --package-lock=false --ignore-scripts --no-audit --no-fund "$INSTALL_TARBALL_PATH"; then
    echo "ERROR: packed artifact cannot be installed by a clean consumer" >&2
    exit 1
  fi
  if ! (cd "$CONSUMER" && node --input-type=module -e 'await import(process.argv[1])' "$PKG_NAME"); then
    echo "ERROR: clean consumer cannot import $PKG_NAME" >&2
    exit 1
  fi
  echo "  OK: clean consumer install and import"
fi

echo "OK: $PKG_NAME packs correctly — all declared exports present."
exit 0
