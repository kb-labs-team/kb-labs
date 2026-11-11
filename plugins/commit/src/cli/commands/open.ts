/**
 * commit:open command
 * Show current commit plan
 */

import { defineCommand, findRepoRoot, useConfig, handleError, type PluginCommandContextV3 } from '@kb-labs/sdk';
import type { CommandResult } from '@kb-labs/sdk';
import { loadPlan, getCurrentPlanPath, formatCommitMessage } from '../../core/index.js';
import { checkPlanStaleness } from '../../core/validator/index.js';
import { resolveCommitConfig, type CommitPluginConfig, type OpenOutput } from '../../contracts/index.js';
import { resolveScopePath } from '../../rest/handlers/scope-resolver';

type OpenInput = {
  json?: boolean;
  scope?: string;
};

type OpenResult = CommandResult<OpenOutput>;

export default defineCommand({
  id: 'commit:open',
  description: 'Show current commit plan',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: OpenInput): Promise<OpenResult> {
      const startTime = Date.now();
      const cwd = (await findRepoRoot(ctx.cwd || process.cwd())) ?? process.cwd();

      const scope = input.scope ?? 'root';

      // Load current plan
      let plan;
      try {
        plan = await loadPlan(cwd, scope);
      } catch (err) {
        return handleError(err);
      }
      const planPath = getCurrentPlanPath(cwd, scope);

      // Proactively check staleness — same shared check applyCommitPlan runs
      // as a last-second guard, but here it's informational so the user finds
      // out before running `kb commit:apply` and hitting a raw git error.
      let stale: boolean | undefined;
      let staleReason: string | undefined;
      if (plan) {
        const fileConfig = await useConfig<Partial<CommitPluginConfig>>();
        const config = resolveCommitConfig(fileConfig ?? {});
        const scopeCwd = resolveScopePath(cwd, scope, config.scope?.scopes);
        const staleness = await checkPlanStaleness(scopeCwd, plan, scope);
        stale = staleness.isStale;
        staleReason = staleness.isStale ? staleness.reason : undefined;
      }

      // Output
      const output: OpenOutput = {
        hasPlan: plan !== null,
        plan: plan ?? undefined,
        planPath: plan ? planPath : undefined,
        stale,
        staleReason,
      };

      if (input.json) {
        return output;
      } else {
        if (!plan) {
          ctx.ui?.info?.('No commit plan found. Run `kb commit:generate` to create one.');
        } else {
          if (stale) {
            ctx.ui?.warn?.(`Plan is outdated: ${staleReason}`);
          }

          // Build commits section
          const commitsItems = plan.commits.map((commit, i) => {
            const message = formatCommitMessage(commit);
            const breaking = commit.breaking ? ' ⚠️  BREAKING' : '';
            return `${i + 1}. ${message} [${commit.files.length} file(s)]${breaking}`;
          });

          // Build git status section
          const status = plan.gitStatus;
          const statusItems = [
            `Staged: ${status.staged.length} file(s)`,
            `Unstaged: ${status.unstaged.length} file(s)`,
            `Untracked: ${status.untracked.length} file(s)`,
          ];

          const sections: Array<{ header?: string; items: string[] }> = [];

          sections.push({
            header: 'Commits',
            items: commitsItems,
          });

          sections.push({
            header: 'Git Status (at generation)',
            items: statusItems,
          });

          const summaryItems: string[] = [
            `Plan path: ${planPath}`,
            `Created: ${plan.createdAt}`,
            `Total files: ${plan.metadata.totalFiles}`,
            `Total commits: ${plan.metadata.totalCommits}`,
            `Status: ${stale ? `⚠️  Outdated — ${staleReason}` : '✅ Up to date'}`,
          ];

          if (plan.metadata.llmUsed) {
            const generator = plan.metadata.escalated ? 'LLM (Phase 2)' : 'LLM (Phase 1)';
            summaryItems.push(`Generator: ${generator}`);
          } else {
            summaryItems.push('Generator: Heuristics');
          }

          sections.unshift({
            header: 'Summary',
            items: summaryItems,
          });

          ctx.ui?.success?.('Current Commit Plan', {
            sections,
          });
        }
      }

      return output;
    },
  },
});
