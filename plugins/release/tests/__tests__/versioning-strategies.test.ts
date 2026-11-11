import { describe, it, expect } from 'vitest';
import { applyVersionStrategy, applyCanarySuffix } from '../../src/core/versioning-strategies';
import type { PackageVersion } from '../../src/core/types';

function pkg(overrides: Partial<PackageVersion>): PackageVersion {
  return {
    name: '@kb-labs/fixture',
    path: '/tmp/fixture',
    gitRoot: '/tmp',
    currentVersion: '1.0.0',
    nextVersion: '1.0.0',
    bump: 'patch',
    isPublished: false,
    ...overrides,
  };
}

describe('applyCanarySuffix', () => {
  it('suffixes the already-computed nextVersion with -canary.<shortsha>', () => {
    const packages = [pkg({ nextVersion: '1.1.0' })];
    const result = applyCanarySuffix(packages, 'abc1234');
    expect(result[0]!.nextVersion).toBe('1.1.0-canary.abc1234');
  });

  it('applies the suffix independently for patch/minor/major base versions', () => {
    const packages = [
      pkg({ name: 'a', nextVersion: '1.0.1' }),
      pkg({ name: 'b', nextVersion: '1.1.0' }),
      pkg({ name: 'c', nextVersion: '2.0.0' }),
    ];
    const result = applyCanarySuffix(packages, 'deadbee');
    expect(result.map(p => p.nextVersion)).toEqual([
      '1.0.1-canary.deadbee',
      '1.1.0-canary.deadbee',
      '2.0.0-canary.deadbee',
    ]);
  });

  it('applies the same suffix to all packages after lockstep resolves a shared base version', () => {
    const packages = [
      pkg({ name: 'a', currentVersion: '1.0.0', nextVersion: '1.0.0', bump: 'minor' }),
      pkg({ name: 'b', currentVersion: '1.0.0', nextVersion: '1.0.0', bump: 'major' }),
    ];
    const lockstepped = applyVersionStrategy(packages, { strategy: 'lockstep' });
    const canaried = applyCanarySuffix(lockstepped, 'ffaa001');
    expect(canaried[0]!.nextVersion).toBe(canaried[1]!.nextVersion);
    expect(canaried[0]!.nextVersion).toBe('2.0.0-canary.ffaa001');
  });

  it('is idempotent-shaped: re-suffixing the same base version with the same SHA reproduces the same output', () => {
    const first = applyCanarySuffix([pkg({ nextVersion: '1.2.3' })], 'aaa1111');
    const second = applyCanarySuffix([pkg({ nextVersion: '1.2.3' })], 'aaa1111');
    expect(first[0]!.nextVersion).toBe(second[0]!.nextVersion);
  });

  it('throws when shortSha is empty', () => {
    expect(() => applyCanarySuffix([pkg({})], '')).toThrow();
  });
});

describe('applyVersionStrategy lockstep — idempotent retry', () => {
  // Reproduces the "tag/commit one version ahead of package.json and npm"
  // bug: on a retry after publish succeeded but the git commit/tag step
  // failed, the planner's per-package idempotent guard (planner.ts) already
  // resolved nextVersion back to the just-published currentVersion and set
  // isPublished: true — that decision must survive lockstep resolution
  // unchanged, not get bumped a second time.
  it('does not re-bump packages already resolved by the idempotent-retry guard', () => {
    const packages = [
      pkg({
        name: '@kb-labs/a',
        currentVersion: '2.114.0',
        nextVersion: '2.114.0',
        bump: 'minor',
        isPublished: true,
      }),
      pkg({
        name: '@kb-labs/b',
        currentVersion: '2.114.0',
        nextVersion: '2.114.0',
        bump: 'minor',
        isPublished: true,
      }),
    ];

    const result = applyVersionStrategy(packages, { strategy: 'lockstep' });

    expect(result.map(p => p.nextVersion)).toEqual(['2.114.0', '2.114.0']);
  });

  // The `release:version` → `release:git` handoff: version bumped
  // package.json on disk, nothing is published yet, and `release:git`
  // re-planned. The planner's trust-disk guard pins nextVersion to the
  // on-disk version, but with isPublished still false. Gating the lockstep
  // guard on isPublished alone let this fall through to a second bump —
  // 2.116.14 → 2.117.0 on disk, tag/commit claiming 2.118.0.
  it('does not re-bump packages pinned to an on-disk bump that is not published yet', () => {
    const packages = [
      pkg({
        name: '@kb-labs/a',
        currentVersion: '2.117.0',
        nextVersion: '2.117.0',
        bump: 'minor',
        isPublished: false,
        versionPinned: true,
      }),
      pkg({
        name: '@kb-labs/b',
        currentVersion: '2.117.0',
        nextVersion: '2.117.0',
        bump: 'minor',
        isPublished: false,
        versionPinned: true,
      }),
    ];

    const result = applyVersionStrategy(packages, { strategy: 'lockstep' });

    expect(result.map(p => p.nextVersion)).toEqual(['2.117.0', '2.117.0']);
  });

  it('pins unresolved packages to the shared resolved version rather than bumping them', () => {
    const packages = [
      pkg({ name: '@kb-labs/a', currentVersion: '2.117.0', nextVersion: '2.117.0', versionPinned: true }),
      pkg({ name: '@kb-labs/b', currentVersion: '2.116.14', nextVersion: '2.117.0', bump: 'minor' }),
    ];

    const result = applyVersionStrategy(packages, { strategy: 'lockstep' });

    expect(result.map(p => p.nextVersion)).toEqual(['2.117.0', '2.117.0']);
  });

  it('fails loudly when already-resolved versions disagree instead of collapsing to the max', () => {
    const packages = [
      pkg({ name: '@kb-labs/a', currentVersion: '2.117.0', nextVersion: '2.117.0', versionPinned: true }),
      pkg({ name: '@kb-labs/b', currentVersion: '2.118.0', nextVersion: '2.118.0', versionPinned: true }),
    ];

    expect(() => applyVersionStrategy(packages, { strategy: 'lockstep' }))
      .toThrow(/conflicting already-resolved versions/);
  });

  // Regression: getMaxBump() used to start its floor at 'patch', so a
  // lockstep group where every package resolved to 'none' (no commits since
  // its last release tag — e.g. re-planning at an already-tagged commit)
  // still got force-bumped by one patch instead of staying put. See the
  // matching fix in planner.ts's detectVersionFromCommits().
  it('does not bump at all when every package in the group resolved to "none"', () => {
    const packages = [
      pkg({ name: '@kb-labs/a', currentVersion: '2.119.0', nextVersion: '2.119.0', bump: 'none' }),
      pkg({ name: '@kb-labs/b', currentVersion: '2.119.0', nextVersion: '2.119.0', bump: 'none' }),
    ];

    const result = applyVersionStrategy(packages, { strategy: 'lockstep' });

    expect(result.map(p => p.nextVersion)).toEqual(['2.119.0', '2.119.0']);
    expect(result.every(p => p.bump === 'none')).toBe(true);
  });

  it('still bumps the whole group when at least one package has a real bump alongside "none" packages', () => {
    const packages = [
      pkg({ name: '@kb-labs/a', currentVersion: '2.119.0', nextVersion: '2.119.0', bump: 'none' }),
      pkg({ name: '@kb-labs/b', currentVersion: '2.119.0', nextVersion: '2.119.0', bump: 'patch' }),
    ];

    const result = applyVersionStrategy(packages, { strategy: 'lockstep' });

    expect(result.map(p => p.nextVersion)).toEqual(['2.119.1', '2.119.1']);
  });
});
