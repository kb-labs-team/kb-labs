#!/usr/bin/env bash
# Pack all publishable @kb-labs/* packages into tarballs.
# Output goes to e2e/packages/ by default (first arg overrides).
#
# Must be run AFTER pnpm install + kb-devkit run build.
#
# Usage:
#   ./e2e/scripts/pack-all.sh
#   ./e2e/scripts/pack-all.sh /custom/output/dir

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="${1:-$REPO_ROOT/e2e/packages}"

# pnpm pack runs from each package directory, so a relative destination would
# resolve differently for every package (and can leave the requested output
# directory empty). Normalize custom destinations before changing directory.
case "$OUT_DIR" in
  /*) ;;
  *) OUT_DIR="$REPO_ROOT/$OUT_DIR" ;;
esac

# Operate from REPO_ROOT so relative package paths (./core/…) resolve and the
# path-exclusion patterns below don't match the repo root's own absolute path
# (critical under .claude/worktrees/<id>/). OUT_DIR is absolute, set first.
cd "$REPO_ROOT"

mkdir -p "$OUT_DIR"
# Clean previous packs so stale tarballs don't accumulate
rm -f "$OUT_DIR"/*.tgz 2>/dev/null || true

echo "==> Packing all @kb-labs/* packages → $OUT_DIR"

PACKED=0
SKIPPED=0
FAILED=0

# Iterate every package.json in the repo (excluding node_modules and .kb)
while IFS= read -r pkg_json; do
  pkg_dir="$(dirname "$pkg_json")"

  # Read name + private flag
  pkg_name="$(jq -r '.name // ""' "$pkg_json" 2>/dev/null)"
  pkg_private="$(jq -r '.private // false' "$pkg_json" 2>/dev/null)"

  # Skip non-@kb-labs, private, and the root monorepo package
  [[ "$pkg_name" == @kb-labs/* ]] || continue
  [ "$pkg_name" != "@kb-labs/monorepo" ] || continue
  [ "$pkg_private" != "true" ] || { SKIPPED=$((SKIPPED+1)); continue; }

  # Skip if no dist/ and package declares dist-relative exports
  # (means it wasn't built — pnpm pack would produce an empty tarball)
  has_exports="$(jq -r '(.main // .exports // "") | tostring' "$pkg_json" 2>/dev/null)"
  if [[ "$has_exports" == *"dist"* ]] && [ ! -d "$pkg_dir/dist" ]; then
    echo "  WARN skip (not built): $pkg_name"
    SKIPPED=$((SKIPPED+1))
    continue
  fi

  package_started=$SECONDS
  printf '[%s] package-pack=start name=%s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$pkg_name"
  if (cd "$pkg_dir" && pnpm pack --pack-destination "$OUT_DIR" --silent 2>/dev/null); then
    PACKED=$((PACKED+1))
    printf '[%s] package-pack=complete name=%s elapsed_seconds=%d\n' \
      "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$pkg_name" "$((SECONDS - package_started))"
  else
    printf '[%s] package-pack=failed name=%s elapsed_seconds=%d\n' \
      "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$pkg_name" "$((SECONDS - package_started))"
    echo "  WARN pack failed: $pkg_name"
    FAILED=$((FAILED+1))
  fi

# Find from REPO_ROOT using RELATIVE paths (cd + "find .") so the path-exclusion
# patterns match real subdirectories, not the repo root's own absolute path. This
# matters in a git worktree under .claude/worktrees/<id>/, where an absolute
# find would make every path match "*/.claude/*" and exclude the whole tree.
done < <(cd "$REPO_ROOT" && find . \
  -not -path "*/node_modules/*" \
  -not -path "*/.kb/*" \
  -not -path "*/e2e/*" \
  -not -path "*/.git/*" \
  -not -path "*/.claude/*" \
  -name "package.json" \
  | sort)

# These E2E-only registry packages are declared once and consumed by both the
# publisher and candidate source-fidelity validator.
while IFS= read -r extra; do
  fixture_dir="$REPO_ROOT/$(jq -r '.directory' <<< "$extra")"
  fixture_name="$(jq -r '.name' "$fixture_dir/package.json")"
  package_started=$SECONDS
  printf '[%s] package-pack=start name=%s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$fixture_name"
  if (cd "$fixture_dir" && pnpm pack --pack-destination "$OUT_DIR" --silent); then
    PACKED=$((PACKED+1))
    printf '[%s] package-pack=complete name=%s elapsed_seconds=%d\n' \
      "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$fixture_name" "$((SECONDS - package_started))"
  else
    printf '[%s] package-pack=failed name=%s elapsed_seconds=%d\n' \
      "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$fixture_name" "$((SECONDS - package_started))"
    echo "ERROR: could not pack $fixture_name"
    exit 1
  fi
done < <(jq -c '.[]' "$REPO_ROOT/e2e/scripts/pack-extras.json")

echo ""
echo "==> Done: $PACKED packed, $SKIPPED skipped (private/not-built), $FAILED failed"
echo "    Output: $OUT_DIR ($(find "$OUT_DIR" -maxdepth 1 -type f -name '*.tgz' 2>/dev/null | wc -l | tr -d ' ') tarballs)"

if [ "$FAILED" -gt 0 ]; then
  echo "ERROR: $FAILED packages failed to pack"
  exit 1
fi

# A workspace reference is valid inside this monorepo but invalid after a
# package is published to Verdaccio/npm. Keep this invariant at the packaging
# boundary so a broken tarball cannot poison a registry snapshot or an E2E
# cache and only fail much later inside a customer's fresh install.
echo "==> Validating published package metadata"
package_validation_started=$SECONDS
INVALID=0
for tarball in "$OUT_DIR"/*.tgz; do
  [ -f "$tarball" ] || continue
  if ! tar -xOzf "$tarball" package/package.json 2>/dev/null \
    | jq -e '[.. | strings | select(startswith("workspace:"))] | length == 0' >/dev/null; then
    echo "  ERROR: workspace dependency leaked into $(basename "$tarball")"
    INVALID=$((INVALID+1))
  fi
done
if [ "$INVALID" -gt 0 ]; then
  echo "ERROR: $INVALID published tarballs contain workspace:* references"
  exit 1
fi
printf '[%s] package-metadata-validation=complete elapsed_seconds=%d\n' \
  "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$((SECONDS - package_validation_started))"
echo "    All published tarballs contain registry-resolvable dependencies"
