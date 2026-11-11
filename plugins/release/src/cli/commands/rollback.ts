/**
 * Release rollback command
 */

import { defineCommand, type CLIInput, type CommandResult, type PluginCommandContextV3 } from '@kb-labs/sdk';
import { restoreSnapshot } from '../../core/index.js';
import { findRepoRoot } from '../../shared/utils';

interface RollbackFlags {
  json?: boolean;
}

type ReleaseRollbackResult = CommandResult<unknown>;

export default defineCommand({
  id: 'release:rollback',
  description: 'Rollback last release',

  handler: {
    async intent(_ctx: PluginCommandContextV3, _input: CLIInput<RollbackFlags>) {
      return {
        summary: 'Rollback last release from backup snapshot',
        operations: [
          { type: 'update' as const, resource: 'package-json-files', details: { source: 'release-snapshot' } },
        ],
      };
    },

    async execute(ctx: PluginCommandContextV3, input: CLIInput<RollbackFlags>): Promise<ReleaseRollbackResult> {
      const { flags } = input;
      const cwd = ctx.cwd || process.cwd();
      const repoRoot = await findRepoRoot(cwd);

      await restoreSnapshot(repoRoot);

      ctx.platform?.logger?.info?.('Release rollback completed');

      if (flags.json) {
      return { message: 'Rollback completed' };
      } else {
        ctx.ui?.sideBox?.({
          title: 'Rollback',
          sections: [
            {
              items: [
                `${ctx.ui.symbols.success} ${ctx.ui.colors.success('Release state restored from backup snapshot')}`,
              ],
            },
          ],
          status: 'success',
        });
      }

      // Return exit code 4 for rollback executed
      return { message: 'Rollback completed' };
    },
  },
});
