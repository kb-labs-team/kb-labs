/**
 * Plan resolution shared by the atomic release steps that must act on the
 * SAME plan (`release:version` → `release:git`).
 *
 * Why this exists: each step used to call planRelease() independently and
 * hope the results matched. They don't have to — planning is a function of
 * disk state, and the step in between mutates exactly that state. A plan
 * re-derived after `release:version` sees the bumped versions as the new
 * baseline and bumps again, so the tag/commit message end up one version
 * ahead of the package.json files actually being committed.
 *
 * The plan written by `release:plan` is the single source of truth for a
 * pipeline run. It is only reused when it provably describes the current
 * state of the working tree, so a stale per-run artifact can never be adopted
 * silently.
 */

import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  planRelease,
  type ReleasePlan,
  type ReleaseConfig,
  type VersionBump,
  type ReleaseChannel,
} from '../core/index.js';
import { scopeToDir } from './utils';

/**
 * Which side of the version bump the caller sits on — determines which field
 * of the plan the on-disk package.json versions are expected to match.
 */
export type PlanStage =
  /** `release:version`: bump not applied yet, disk should still be at currentVersion. */
  | 'pre-bump'
  /** `release:git`: bump already applied, disk should be at nextVersion. */
  | 'post-bump';

export interface ResolvePlanOptions {
  repoRoot: string;
  config: ReleaseConfig;
  scope?: string;
  flow?: string;
  bumpOverride?: VersionBump;
  channel?: ReleaseChannel;
  stage: PlanStage;
}

export interface ResolvedPlan {
  plan: ReleasePlan;
  /** 'artifact' — reused the plan from `release:plan`; 'computed' — planned fresh. */
  source: 'artifact' | 'computed';
  /** Why the artifact was rejected, when source is 'computed' and one existed. */
  reason?: string;
}

export function releasePlanPath(repoRoot: string, scope?: string): string {
  return join(repoRoot, '.kb', 'release', 'plans', scopeToDir(scope ?? 'root'), 'current', 'plan.json');
}

async function readDiskVersion(packagePath: string): Promise<string | undefined> {
  try {
    const raw = await readFile(join(packagePath, 'package.json'), 'utf-8');
    return (JSON.parse(raw) as { version?: string }).version;
  } catch {
    return undefined;
  }
}

/**
 * Reject the persisted plan unless every package it covers is on disk at the
 * version this stage expects. That single check subsumes staleness, partial
 * runs, and out-of-band edits: any of them show up as a version mismatch.
 */
async function validateAgainstDisk(plan: ReleasePlan, stage: PlanStage): Promise<string | undefined> {
  const expectedField = stage === 'pre-bump' ? 'currentVersion' : 'nextVersion';

  for (const pkg of plan.packages) {
    const onDisk = await readDiskVersion(pkg.path);
    if (onDisk === undefined) {
      return `${pkg.name}: package.json not readable at ${pkg.path}`;
    }
    const expected = pkg[expectedField];
    if (onDisk !== expected) {
      return `${pkg.name}: expected ${expectedField} ${expected} on disk, found ${onDisk}`;
    }
  }

  return undefined;
}

/**
 * Load the plan produced by `release:plan` when it matches this run and the
 * working tree; otherwise plan fresh.
 */
export async function resolvePlan(options: ResolvePlanOptions): Promise<ResolvedPlan> {
  const { repoRoot, config, scope, flow, bumpOverride, channel, stage } = options;

  const computeFresh = async (reason?: string): Promise<ResolvedPlan> => ({
    plan: await planRelease({ cwd: repoRoot, config, scope, flow, bumpOverride, channel }),
    source: 'computed',
    ...(reason ? { reason } : {}),
  });

  let persisted: ReleasePlan;
  try {
    persisted = JSON.parse(await readFile(releasePlanPath(repoRoot, scope), 'utf-8')) as ReleasePlan;
  } catch {
    return computeFresh();
  }

  if (!Array.isArray(persisted.packages) || persisted.packages.length === 0) {
    return computeFresh('persisted plan has no packages');
  }

  // All flows share one scope-derived artifact path, so an unrelated flow's
  // plan can legitimately be sitting there. Never adopt it.
  if ((persisted.flow ?? undefined) !== (flow ?? undefined)) {
    return computeFresh(`persisted plan is for flow "${persisted.flow ?? '<none>'}", requested "${flow ?? '<none>'}"`);
  }
  if ((persisted.scope ?? undefined) !== (scope ?? undefined)) {
    return computeFresh(`persisted plan is for scope "${persisted.scope ?? '<none>'}", requested "${scope ?? '<none>'}"`);
  }
  if (channel !== undefined && persisted.channel !== channel) {
    return computeFresh(`persisted plan is for channel "${persisted.channel}", requested "${channel}"`);
  }

  const mismatch = await validateAgainstDisk(persisted, stage);
  if (mismatch) {
    return computeFresh(`persisted plan does not match working tree (${mismatch})`);
  }

  return { plan: persisted, source: 'artifact' };
}
