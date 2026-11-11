/**
 * Versioning strategies for monorepo package releases
 *
 * - lockstep: All packages get the same version (maximum bump)
 * - independent: Each package has its own version
 * - adaptive: Lockstep if breaking changes, otherwise independent
 */

import semver from 'semver';
import type { PackageVersion, VersionBump } from './types';

export type VersionStrategy = 'lockstep' | 'independent' | 'adaptive';

export interface StrategyOptions {
  strategy: VersionStrategy;
  umbrellaPath?: string; // path to umbrella root (for filtering)
}

/**
 * Apply versioning strategy to packages
 */
export function applyVersionStrategy(
  packages: PackageVersion[],
  options: StrategyOptions
): PackageVersion[] {
  if (options.strategy === 'lockstep') {
    return applyLockstep(packages);
  }

  if (options.strategy === 'adaptive') {
    return applyAdaptive(packages);
  }

  // independent (default) - no changes needed
  return packages;
}

/**
 * Lockstep: All packages get the maximum version bump
 *
 * Example:
 * - Package A: 1.0.0 -> 1.1.0 (minor)
 * - Package B: 1.0.0 -> 2.0.0 (major)
 * Result: Both get 2.0.0 (maximum bump = major)
 */
function applyLockstep(packages: PackageVersion[]): PackageVersion[] {
  if (packages.length === 0) {return packages;}

  // Idempotent retry: the planner's per-package guard (planner.ts) already
  // resolved nextVersion back to currentVersion — without a fresh bump — for
  // any package whose bump is already applied on disk. That decision must
  // survive lockstep resolution unchanged: re-deriving nextVersion from
  // currentVersion here would bump a SECOND time on top of an already-applied
  // bump, producing a git tag/commit one version ahead of what's actually in
  // package.json.
  //
  // Both signals matter, and `isPublished` alone is NOT sufficient:
  //   - isPublished   — bump applied AND live on npm (publish succeeded, only
  //                     git commit/tag remains).
  //   - versionPinned — bump applied on disk, not yet published. This is the
  //                     ordinary `release:version` → `release:git` handoff,
  //                     where nothing is on npm yet. Gating on isPublished
  //                     alone let this case fall through to a second bump.
  const pinned = packages.filter(p => p.isPublished || p.versionPinned);
  if (pinned.length > 0) {
    // In lockstep every package shares one version, so the already-resolved
    // ones must agree. If they don't, the plan is incoherent — fail here with
    // the actual versions rather than silently collapsing to the max and
    // tripping assertTagVersionsMatchDisk() later, after the commit is made.
    const resolved = [...new Set(pinned.map(p => p.nextVersion))];
    if (resolved.length > 1) {
      const detail = pinned.map(p => `${p.name}@${p.nextVersion}`).join(', ');
      throw new Error(
        `Lockstep release has conflicting already-resolved versions: ${resolved.join(', ')} (${detail}). ` +
        'Reconcile package.json versions before releasing.',
      );
    }
    const sharedVersion = resolved[0]!;
    return packages.map(pkg => ({ ...pkg, nextVersion: sharedVersion }));
  }

  // Find the maximum bump level
  const maxBump = getMaxBump(packages);

  // Find the highest current version
  const maxVersion = packages.reduce((max, pkg) => {
    return semver.gt(pkg.currentVersion, max) ? pkg.currentVersion : max;
  }, packages[0]!.currentVersion); // ! safe: length already checked

  // No package in the lockstep group had any commits since its last release
  // tag ('none') — nothing to release, so the shared version must stay
  // exactly where it is. Previously getMaxBump() had no 'none' floor (it
  // started at 'patch'), so an all-unchanged lockstep group still bumped a
  // patch on every re-plan — e.g. re-running `release version update` against a
  // commit that's already tagged at the target version.
  if (maxBump === 'none') {
    return packages.map(pkg => ({
      ...pkg,
      bump: 'none' as const,
      nextVersion: maxVersion,
    }));
  }

  // Compute next version from max version + max bump
  // Filter out 'auto' since semver.inc expects ReleaseType
  const releaseType = maxBump === 'auto' ? 'patch' : maxBump;
  const nextVersion = semver.inc(maxVersion, releaseType) || maxVersion;

  // Apply to all packages
  return packages.map(pkg => ({
    ...pkg,
    bump: maxBump,
    nextVersion,
  }));
}

/**
 * Adaptive: Lockstep if breaking changes, otherwise independent
 *
 * This is useful for umbrellas where you want to keep versions in sync
 * when there are breaking changes, but allow independent releases otherwise.
 */
function applyAdaptive(packages: PackageVersion[]): PackageVersion[] {
  const hasBreaking = packages.some(pkg => pkg.bump === 'major');

  // If any package has breaking changes, use lockstep
  if (hasBreaking) {
    return applyLockstep(packages);
  }

  // Otherwise, use independent (no changes)
  return packages;
}

/**
 * Apply a canary prerelease suffix to already-computed nextVersion values.
 *
 * Runs AFTER applyVersionStrategy() (lockstep/independent/adaptive) has
 * resolved the base bump — canary is orthogonal to bump size, so it's a
 * pure post-processing step rather than a VersionBump variant. Given a
 * short git SHA, `1.2.3` (base next version) becomes `1.2.3-canary.<sha>`.
 *
 * Deterministic per (nextVersion, shortSha) pair — retrying the same commit
 * reproduces the same canary version, so publish-side idempotency handling
 * (already-published patterns) makes retries safe without extra state.
 */
export function applyCanarySuffix(packages: PackageVersion[], shortSha: string): PackageVersion[] {
  if (!shortSha) {
    throw new Error('applyCanarySuffix: shortSha is required to build a canary version');
  }
  return packages.map(pkg => ({
    ...pkg,
    nextVersion: `${pkg.nextVersion}-canary.${shortSha}`,
  }));
}

/**
 * Get the maximum bump level from a list of packages
 *
 * Priority: major > minor > patch > none
 *
 * Starts at 'none', not 'patch': a lockstep group where every package
 * resolved to 'none' (no commits since its last release tag) must not be
 * force-bumped to a patch — that floor previously made lockstep re-plans of
 * an already-tagged, unchanged commit always advance the version by one
 * patch (see applyLockstep()'s 'none' branch, and the matching fix in
 * planner.ts's detectVersionFromCommits()).
 */
function getMaxBump(packages: PackageVersion[]): VersionBump {
  let maxBump: VersionBump = 'none';

  for (const pkg of packages) {
    if (pkg.bump === 'major') {
      return 'major'; // Can't go higher than major
    }
    if (pkg.bump === 'minor') {
      maxBump = 'minor';
    }
    if (pkg.bump === 'patch' && maxBump !== 'minor') {
      maxBump = 'patch';
    }
    if (pkg.bump === 'auto' && maxBump === 'none') {
      // Defensive: an unresolved 'auto' bump should never reach here (the
      // planner always resolves 'auto' to a concrete level before strategy
      // application), but treat it as at least a patch rather than silently
      // dropping to 'none'.
      maxBump = 'patch';
    }
  }

  return maxBump;
}
