/**
 * Checklist handler - Get unified release checklist status
 *
 * Returns status of all release steps: plan, changelog, build, preview
 */

import { defineHandler, findRepoRoot, useEnv, type RestInput, rethrowForRest } from '@kb-labs/sdk';
import type {
  ReleaseChecklist,
  ChecklistItemStatus,
  ReleasePlan,
} from '../../contracts/index.js';
import { readFile, access, readdir, stat } from 'node:fs/promises';
import { scopeToDir } from '../../shared/utils';
import { join } from 'node:path';

interface ChecklistInput {
  scope?: string;
}

// ── helpers ────────────────────────────────────────────────────────────────

async function countFiles(dir: string): Promise<{ count: number; size: number }> {
  let count = 0;
  let size = 0;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await countFiles(fullPath);
      count += sub.count;
      size += sub.size;
    } else {
      count++;
      const fileStat = await stat(fullPath);
      size += fileStat.size;
    }
  }
  return { count, size };
}

interface PlanCheckResult {
  planStatus: ChecklistItemStatus;
  planMessage: string;
  packagesCount: number;
  bump: string | undefined;
  plan: ReleasePlan | undefined;
}

async function checkPlanStatus(basePath: string): Promise<PlanCheckResult> {
  try {
    const planRaw = await readFile(join(basePath, 'plan.json'), 'utf-8');
    const parsedPlan: ReleasePlan = JSON.parse(planRaw);
    const packagesCount = parsedPlan.packages.length;
    const bump = parsedPlan.packages[0]?.bump;
    return {
      planStatus: 'ready',
      planMessage: `${packagesCount} package${packagesCount !== 1 ? 's' : ''}, ${bump} bump`,
      packagesCount,
      bump,
      plan: parsedPlan,
    };
  } catch {
    return { planStatus: 'pending', planMessage: 'No release plan found', packagesCount: 0, bump: undefined, plan: undefined };
  }
}

interface ChangelogCheckResult {
  changelogStatus: ChecklistItemStatus;
  changelogMessage: string;
  commitsCount: number | undefined;
}

async function checkChangelogStatus(basePath: string, planStatus: ChecklistItemStatus): Promise<ChangelogCheckResult> {
  try {
    const changelogPath = join(basePath, 'CHANGELOG.md');
    await access(changelogPath);
    const changelog = await readFile(changelogPath, 'utf-8');
    const commitMatches = changelog.match(/^- /gm);
    const commitsCount = commitMatches?.length || 0;
    return {
      changelogStatus: 'ready',
      changelogMessage: `${commitsCount} change${commitsCount !== 1 ? 's' : ''} documented`,
      commitsCount,
    };
  } catch {
    const changelogMessage = planStatus === 'ready' ? 'Generate changelog to continue' : 'Changelog not generated';
    return { changelogStatus: 'pending', changelogMessage, commitsCount: undefined };
  }
}

interface BuildCheckResult {
  buildStatus: ChecklistItemStatus;
  buildMessage: string;
  builtCount: number;
  totalCount: number;
}

async function checkBuildStatus(plan: ReleasePlan | undefined, repoRoot: string): Promise<BuildCheckResult> {
  if (!plan) {
    return { buildStatus: 'pending', buildMessage: 'Build required', builtCount: 0, totalCount: 0 };
  }
  const totalCount = plan.packages.length;
  let builtCount = 0;
  for (const pkg of plan.packages) {
    const packagePath = pkg.path.startsWith('/') ? pkg.path : join(repoRoot, pkg.path);
    try {
      await access(join(packagePath, 'dist'));
      builtCount++;
    } catch {
      // Not built
    }
  }
  if (builtCount === totalCount) {
    return {
      buildStatus: 'ready',
      buildMessage: `All ${totalCount} package${totalCount !== 1 ? 's' : ''} built`,
      builtCount,
      totalCount,
    };
  }
  if (builtCount > 0) {
    return { buildStatus: 'warning', buildMessage: `${builtCount}/${totalCount} packages built`, builtCount, totalCount };
  }
  return {
    buildStatus: 'pending',
    buildMessage: `${totalCount} package${totalCount !== 1 ? 's' : ''} need build`,
    builtCount,
    totalCount,
  };
}

interface PreviewCheckResult {
  previewStatus: ChecklistItemStatus;
  previewMessage: string;
  filesCount: number | undefined;
  totalSize: number | undefined;
}

async function checkPreviewStatus(
  plan: ReleasePlan | undefined,
  repoRoot: string,
  buildStatus: ChecklistItemStatus,
): Promise<PreviewCheckResult> {
  if (buildStatus !== 'ready' || !plan) {
    return { previewStatus: 'pending', previewMessage: 'Waiting for build', filesCount: undefined, totalSize: undefined };
  }
  let filesCount = 0;
  let totalSize = 0;
  for (const pkg of plan.packages) {
    const packagePath = pkg.path.startsWith('/') ? pkg.path : join(repoRoot, pkg.path);
    try {
      const result = await countFiles(join(packagePath, 'dist'));
      filesCount += result.count;
      totalSize += result.size;
    } catch {
      // Skip - dist doesn't exist or error reading
    }
  }
  if (filesCount > 0) {
    return {
      previewStatus: 'ready',
      previewMessage: `${filesCount} file${filesCount !== 1 ? 's' : ''} ready to publish`,
      filesCount,
      totalSize,
    };
  }
  return { previewStatus: 'warning', previewMessage: 'No files found to publish', filesCount, totalSize };
}

// ── handler ────────────────────────────────────────────────────────────────

export default defineHandler({
  async execute(ctx, input: RestInput<ChecklistInput>): Promise<ReleaseChecklist> {
    try {
      const scope = input.query?.scope || 'root';
      const cwd = ctx.cwd ?? process.cwd();
      const repoRoot = await findRepoRoot(cwd);

      const scopeDir = scopeToDir(scope);
      const basePath = join(repoRoot, '.kb/release/plans', scopeDir, 'current');

      const { planStatus, planMessage, packagesCount, bump, plan } = await checkPlanStatus(basePath);
      const { changelogStatus, changelogMessage, commitsCount } = await checkChangelogStatus(basePath, planStatus);
      const { buildStatus, buildMessage, builtCount, totalCount } = await checkBuildStatus(plan, repoRoot);
      const { previewStatus, previewMessage, filesCount, totalSize } = await checkPreviewStatus(plan, repoRoot, buildStatus);

      const hasNpmToken = !!(useEnv('NPM_TOKEN') ?? useEnv('NODE_AUTH_TOKEN'));
      const npmStatus: ChecklistItemStatus = hasNpmToken ? 'ready' : 'error';
      const npmMessage = hasNpmToken
        ? 'npm token configured'
        : 'Set NPM_TOKEN (granular access token) in environment';

      const canPublish =
        planStatus === 'ready' &&
        changelogStatus === 'ready' &&
        buildStatus === 'ready' &&
        previewStatus === 'ready' &&
        npmStatus === 'ready';

      return {
        scope,
        plan: {
          status: planStatus,
          message: planMessage,
          packagesCount: packagesCount > 0 ? packagesCount : undefined,
          bump,
        },
        changelog: {
          status: changelogStatus,
          message: changelogMessage,
          commitsCount,
        },
        build: {
          status: buildStatus,
          message: buildMessage,
          builtCount: builtCount > 0 ? builtCount : undefined,
          totalCount: totalCount > 0 ? totalCount : undefined,
        },
        preview: {
          status: previewStatus,
          message: previewMessage,
          filesCount,
          totalSize,
        },
        npm: {
          status: npmStatus,
          message: npmMessage,
        },
        canPublish,
      };
    } catch (err) {
      rethrowForRest(err);
    }
  },
});
