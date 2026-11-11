/**
 * commit:reset command
 * Clear current commit plan
 */

import { defineCommand, findRepoRoot, handleError, type PluginCommandContextV3 } from '@kb-labs/sdk';
import type { CommandResult } from '@kb-labs/sdk';
import { clearPlan, hasPlan } from '../../core/index.js';
import type { ResetOutput } from '../../contracts/index.js';

type ResetInput = {
  json?: boolean;
  scope?: string;
};

type ResetResult = CommandResult<ResetOutput>;

export default defineCommand({
  id: 'commit:reset',
  description: 'Clear current commit plan',

  handler: {
    async intent(_ctx: PluginCommandContextV3, input: ResetInput) {
      const scope = input.scope ?? 'root';
      return {
        summary: `Clear commit plan (scope: "${scope}")`,
        operations: [{ type: 'delete' as const, resource: 'commit-plan', details: { scope } }],
      };
    },

    async execute(ctx: PluginCommandContextV3, input: ResetInput): Promise<ResetResult> {
      const startTime = Date.now();
      const cwd = (await findRepoRoot(ctx.cwd || process.cwd())) ?? process.cwd();

      const scope = input.scope ?? 'root';

      // Check if plan exists
      const exists = await hasPlan(cwd, scope);

      if (!exists) {
        ctx.ui?.info?.('No commit plan to clear.');
        return {
            success: true,
            message: 'No commit plan to clear.',
          };
      }

      // Clear plan
      try {
        await clearPlan(cwd, scope);
      } catch (err) {
        return handleError(err);
      }

      ctx.ui?.success?.('Plan Cleared', {
        sections: [{
          items: [
            'Status: ✅ Cleared successfully',
            'Action: Run `kb commit plan create` to create a new plan',
          ],
        }],
      });

      return {
          success: true,
          message: 'Commit plan cleared successfully.',
        };
    },
  },
});
