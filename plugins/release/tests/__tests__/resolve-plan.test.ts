import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReleasePlan } from '../../src/core/index.js';

const planRelease = vi.hoisted(() => vi.fn());
vi.mock('../../src/core/index.js', () => ({ planRelease }));

const { resolvePlan, releasePlanPath } = await import('../../src/shared/resolve-plan.js');

let repoRoot: string;

/** Write a package.json at <repoRoot>/<dir> with the given version. */
async function writePackage(dir: string, name: string, version: string): Promise<string> {
  const path = join(repoRoot, dir);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'package.json'), JSON.stringify({ name, version }), 'utf-8');
  return path;
}

async function writePlan(plan: ReleasePlan, scope?: string): Promise<void> {
  const path = releasePlanPath(repoRoot, scope);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(plan, null, 2), 'utf-8');
}

function makePlan(packagePath: string, overrides: Partial<ReleasePlan> = {}): ReleasePlan {
  return {
    packages: [{
      name: '@kb-labs/a',
      path: packagePath,
      gitRoot: repoRoot,
      currentVersion: '2.116.14',
      nextVersion: '2.117.0',
      bump: 'minor',
      isPublished: false,
    }],
    strategy: 'semver',
    registry: 'https://registry.npmjs.org',
    rollbackEnabled: true,
    channel: 'stable',
    flow: 'platform',
    ...overrides,
  } as ReleasePlan;
}

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), 'kb-resolve-plan-'));
  planRelease.mockReset();
  planRelease.mockResolvedValue({ packages: [], strategy: 'semver', registry: '', rollbackEnabled: true, channel: 'stable' });
});

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
});

describe('resolvePlan', () => {
  it('reuses the persisted plan when disk still sits at currentVersion (pre-bump)', async () => {
    const pkgPath = await writePackage('pkg-a', '@kb-labs/a', '2.116.14');
    await writePlan(makePlan(pkgPath));

    const { plan, source } = await resolvePlan({
      repoRoot, config: {}, flow: 'platform', stage: 'pre-bump',
    });

    expect(source).toBe('artifact');
    expect(plan.packages[0]!.nextVersion).toBe('2.117.0');
    expect(planRelease).not.toHaveBeenCalled();
  });

  it('reuses the persisted plan when disk already sits at nextVersion (post-bump)', async () => {
    const pkgPath = await writePackage('pkg-a', '@kb-labs/a', '2.117.0');
    await writePlan(makePlan(pkgPath));

    const { plan, source } = await resolvePlan({
      repoRoot, config: {}, flow: 'platform', stage: 'post-bump',
    });

    expect(source).toBe('artifact');
    // The whole point: the git step tags 2.117.0, not a re-derived 2.118.0.
    expect(plan.packages[0]!.nextVersion).toBe('2.117.0');
    expect(planRelease).not.toHaveBeenCalled();
  });

  it('rejects a plan belonging to a different flow', async () => {
    const pkgPath = await writePackage('pkg-a', '@kb-labs/a', '2.116.14');
    await writePlan(makePlan(pkgPath, { flow: 'sdk' }));

    const { source, reason } = await resolvePlan({
      repoRoot, config: {}, flow: 'platform', stage: 'pre-bump',
    });

    expect(source).toBe('computed');
    expect(reason).toMatch(/flow "sdk"/);
    expect(planRelease).toHaveBeenCalled();
  });

  it('rejects a stale plan whose versions no longer match the working tree', async () => {
    // A leftover per-run plan must never be adopted on version mismatch.
    const pkgPath = await writePackage('pkg-a', '@kb-labs/a', '2.120.0');
    await writePlan(makePlan(pkgPath));

    const { source, reason } = await resolvePlan({
      repoRoot, config: {}, flow: 'platform', stage: 'pre-bump',
    });

    expect(source).toBe('computed');
    expect(reason).toMatch(/does not match working tree/);
  });

  it('rejects a pre-bump plan when the bump was already applied (and vice versa)', async () => {
    const pkgPath = await writePackage('pkg-a', '@kb-labs/a', '2.117.0');
    await writePlan(makePlan(pkgPath));

    const preBump = await resolvePlan({ repoRoot, config: {}, flow: 'platform', stage: 'pre-bump' });
    expect(preBump.source).toBe('computed');

    const postBump = await resolvePlan({ repoRoot, config: {}, flow: 'platform', stage: 'post-bump' });
    expect(postBump.source).toBe('artifact');
  });

  it('plans fresh when no artifact exists', async () => {
    await writePackage('pkg-a', '@kb-labs/a', '2.116.14');

    const { source } = await resolvePlan({
      repoRoot, config: {}, flow: 'platform', stage: 'pre-bump',
    });

    expect(source).toBe('computed');
    expect(planRelease).toHaveBeenCalledWith(expect.objectContaining({ flow: 'platform' }));
  });

  // Regression for the canary release-build-candidate failure: the candidate
  // workspace regenerates its per-run plan, and a canary resolve may also need
  // to recompute if the artifact no longer matches disk. resolvePlan() rejects
  // that stale plan and recomputes fresh — but if the caller doesn't forward its own
  // `channel` into that recompute, planRelease()'s `channel = 'stable'`
  // default silently takes over and every package's -canary.<sha> suffix
  // is dropped, not just one. `release:version`'s own default `--channel`
  // flag value is 'stable', so exercising the bug means a canary caller
  // must pass channel explicitly, exactly as .github/workflows/
  // release-build-candidate.yml's "Apply planned package versions" step
  // now does.
  it('forwards the caller channel into a fresh replan of a stale artifact', async () => {
    const pkgPath = await writePackage('pkg-a', '@kb-labs/a', '2.120.0');
    await writePlan(makePlan(pkgPath, { channel: 'canary' }));

    const { source } = await resolvePlan({
      repoRoot, config: {}, flow: 'platform', channel: 'canary', stage: 'pre-bump',
    });

    expect(source).toBe('computed');
    expect(planRelease).toHaveBeenCalledWith(expect.objectContaining({ channel: 'canary' }));
  });

  it('rejects a plan belonging to a different channel', async () => {
    const pkgPath = await writePackage('pkg-a', '@kb-labs/a', '2.116.14');
    await writePlan(makePlan(pkgPath, { channel: 'stable' }));

    const { source, reason } = await resolvePlan({
      repoRoot, config: {}, flow: 'platform', channel: 'canary', stage: 'pre-bump',
    });

    expect(source).toBe('computed');
    expect(reason).toMatch(/channel "stable"/);
    expect(planRelease).toHaveBeenCalledWith(expect.objectContaining({ channel: 'canary' }));
  });
});
