/**
 * Shared wiring of runReleasePreflight for `release doctor` and the
 * opt-in `release checks --preflight` step.
 */
import {
  computeFlowReleaseStatus,
  createExecaShellAdapter,
  resolvePublishRegistry,
  runReleasePreflight,
  type PreflightBaseline,
  type PreflightResult,
  type ReleaseConfig,
} from '@kb-labs/release-manager-core';

export interface PreflightInvocation {
  repoRoot: string;
  config: ReleaseConfig;
  flow?: string;
  branch?: string;
  netOffset?: number | string;
  stagingRegistry?: string;
}

function parseOffset(flag: number | string | undefined, envValue: string | undefined): number {
  const raw = flag ?? envValue;
  const n = raw === undefined ? 0 : Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

export async function runPreflightFor(inv: PreflightInvocation): Promise<PreflightResult> {
  const shell = createExecaShellAdapter();
  const flow = inv.flow;
  const baseline = flow
    ? async (): Promise<PreflightBaseline> => {
        const status = await computeFlowReleaseStatus({ cwd: inv.repoRoot, config: inv.config, flow, shell });
        return {
          gitTag: status.git.tag,
          gitVersion: status.git.version,
          npmStableVersion: status.npm.stableVersion,
          npmStableDistTag: status.npm.stableDistTag,
          npmDrift: status.npm.stableDrift,
          npmUnresolved: status.npm.perPackage.every(p => p.error !== undefined),
        };
      }
    : undefined;

  return runReleasePreflight({
    cwd: inv.repoRoot,
    shell,
    fetch: (url, init) => fetch(url, init),
    env: process.env,
    expectedBranch: inv.branch,
    stagingRegistry: inv.stagingRegistry,
    netOffset: parseOffset(inv.netOffset, process.env.KB_NET_OFFSET),
    npmRegistry: resolvePublishRegistry(inv.config, 'canary'),
    flow,
    baseline,
  });
}
