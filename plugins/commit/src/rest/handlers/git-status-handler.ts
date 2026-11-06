import { defineHandler, useConfig, type PluginContextV3, type RestInput, type TableData, type TableRow, rethrowForRest } from '@kb-labs/sdk';
import { getGitStatus } from '../../core/analyzer/index.js';
import { type CommitPluginConfig, resolveCommitConfig } from '../../contracts/index.js';
import { resolveScopePath } from './scope-resolver';

/**
 * GET /git-status handler
 *
 * Returns git status as table data for Studio table widget.
 */
export default defineHandler({
  async execute(ctx: PluginContextV3, input: RestInput<{ scope?: string }>): Promise<TableData> {
    const scope = input.query?.scope || 'root';

    try {
      // Resolve scope to actual directory path
      const fileConfig = await useConfig<Partial<CommitPluginConfig>>();
      const config = resolveCommitConfig(fileConfig ?? {});
      const scopeCwd = resolveScopePath(ctx.cwd, scope, config.scope?.scopes);

      ctx.platform.logger.info('[git-status] Resolution', {
        cwd: ctx.cwd,
        scope,
        scopeCwd,
      });

      // Get git status (git runs FROM scopeCwd, no filtering)
      const status = await getGitStatus(scopeCwd);

      // Convert git status to table rows
      const rows: TableRow[] = [];

      // Add staged files
      for (const filePath of status.staged) {
        rows.push({
          path: filePath,
          status: 'staged',
        });
      }

      // Add unstaged files
      for (const filePath of status.unstaged) {
        rows.push({
          path: filePath,
          status: 'modified',
        });
      }

      // Add untracked files
      for (const filePath of status.untracked) {
        rows.push({
          path: filePath,
          status: 'untracked',
        });
      }

      return {
        rows,
        total: rows.length,
      };
    } catch (error) {
      rethrowForRest(error);
    }
  },
});
