/**
 * commit:apply command
 * Apply current commit plan
 */

import { defineCommand, useLoader, useConfig, findRepoRoot, validationError, type PluginCommandContextV3 } from '@kb-labs/sdk';
import type { CommandResult } from '@kb-labs/sdk';
import {
  applyCommitPlan,
  loadPlan,
  saveToHistory,
  clearPlan,
} from '../../core/index.js';
import type { ApplyOutput, CommitPluginConfig } from '../../contracts/index.js';
import { resolveCommitConfig } from '../../contracts/index.js';
import { resolveScopePath } from '../../rest/handlers/scope-resolver';

type ApplyInput = {
  force?: boolean;
  json?: boolean;
  scope?: string;
};

type ApplyResult = CommandResult<ApplyOutput>;

export default defineCommand({
  id: 'commit:apply',
  description: 'Apply current commit plan',

  handler: {
    async intent(_ctx: PluginCommandContextV3, input: ApplyInput) {
      const scope = input.scope ?? 'root';
      return {
        summary: `Apply current commit plan (scope: "${scope}")`,
        operations: [{ type: 'create' as const, resource: 'git-commits', details: { scope } }],
      };
    },

    async execute(ctx: PluginCommandContextV3, input: ApplyInput): Promise<ApplyResult> {
      const startTime = Date.now();
      const cwd = (await findRepoRoot(ctx.cwd || process.cwd())) ?? process.cwd();

      const scope = input.scope ?? 'root';
      const fileConfig = await useConfig<Partial<CommitPluginConfig>>();
      const config = resolveCommitConfig(fileConfig ?? {});
      const scopeCwd = resolveScopePath(cwd, scope, config.scope?.scopes);

      // Load current plan
      const loadLoader = useLoader('Loading commit plan...');
      loadLoader.start();
      const plan = await loadPlan(cwd, scope);

      if (!plan) {
        loadLoader.fail('No commit plan found');
        return validationError('No commit plan found', 'Run `kb commit plan create` first');
      }

      if (plan.commits.length === 0) {
        loadLoader.stop();
        ctx.ui?.warn?.('Commit plan is empty. Nothing to apply.');
        return {
            success: true,
            commits: [],
            errors: [],
          };
      }
      loadLoader.succeed(`Loaded plan with ${plan.commits.length} commit(s)`);

      // Apply plan
      const applyLoader = useLoader(`Applying ${plan.commits.length} commit(s)...`);
      applyLoader.start();
      const result = await applyCommitPlan(scopeCwd, plan, {
        force: input.force,
      });

      // Save to history and clear current plan on success
      if (result.success) {
        await saveToHistory(cwd, plan, result, scope);
        await clearPlan(cwd, scope);
        applyLoader.succeed(`Applied ${result.appliedCommits.length} commit(s) successfully`);
      } else {
        applyLoader.fail('Failed to apply commits');
      }

      // Output
      const output: ApplyOutput = {
        success: result.success,
        commits: result.appliedCommits.map((c) => ({
          id: c.groupId,
          sha: c.sha,
          message: c.message,
        })),
        errors: result.errors,
      };

      if (input.json) {
        return output;
      } else {
        if (result.success) {
          // Build commits section
          const commitsItems = result.appliedCommits.map((commit) => {
            return `${commit.sha.substring(0, 7)} ${commit.message}`;
          });

          const sections: Array<{ header?: string; items: string[] }> = [];

          if (commitsItems.length > 0) {
            sections.push({
              header: 'Applied Commits',
              items: commitsItems,
            });
          }

          const summaryItems: string[] = [
            `Total commits: ${result.appliedCommits.length}`,
            'Status: ✅ Success',
          ];

          sections.unshift({
            header: 'Summary',
            items: summaryItems,
          });

          const timing = Date.now() - startTime;

          ctx.ui?.success?.('Commits applied successfully', {
            title: 'Apply Commit Plan',
            sections,
            timing,
          });
        } else {
          const errorItems = result.errors.map((error) => error);
          const timing = Date.now() - startTime;


        }
      }

      return result.success ? output : { ok: false, error: { code: 'KB_RUNTIME_COMMAND_FAILED', message: 'Commit apply failed', hint: 'Review the commit plan apply output, then rerun `kb commit plan apply`.' } };
    },
  },
});
