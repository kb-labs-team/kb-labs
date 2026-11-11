import { defineHandler, useConfig, type PluginContextV3, type RestInput, useLogger, rethrowForRest } from '@kb-labs/sdk';
import { type FileDiffResponse, type CommitPluginConfig, resolveCommitConfig } from '../../contracts/index.js';
import { getFileDiff } from '../../core/analyzer/index.js';
import { resolveScopePath } from './scope-resolver';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * GET /diff handler
 *
 * Returns the diff for a specific file in the scope.
 */
export default defineHandler({
  async execute(ctx: PluginContextV3, input: RestInput<{ scope?: string; file?: string }>): Promise<FileDiffResponse> {
    const logger = useLogger();
    const scope = input.query?.scope || 'root';
    const file = input.query?.file;

    logger.info('[diff-handler] Request received', { scope, file });

    if (!file) {
      throw new Error('File path is required');
    }

    try {
      // Resolve scope to actual directory path
      const fileConfig = await useConfig<Partial<CommitPluginConfig>>();
      const config = resolveCommitConfig(fileConfig ?? {});
      const scopeCwd = resolveScopePath(ctx.cwd, scope, config.scope?.scopes);
      logger.info('[diff-handler] Resolved scope', { scope, scopeCwd });

      // Get file diff (git runs FROM scopeCwd)
      logger.info('[diff-handler] Calling getFileDiff', { cwd: scopeCwd, file });
      const result = await getFileDiff(scopeCwd, file);

      // For untracked/new files git diff may be empty.
      // Fallback to raw file content so UI can render a "new file content" view.
      if (!result.diff || result.diff.trim().length === 0) {
        try {
          const absolutePath = join(scopeCwd, file);
          const content = await readFile(absolutePath, 'utf-8');
          const additions = content.length === 0 ? 0 : content.split('\n').length;
          return {
            scope,
            file,
            diff: content,
            additions,
            deletions: 0,
          };
        } catch (readError) {
          logger.warn('[diff-handler] Failed to read file content fallback', {
            file,
            error: readError instanceof Error ? readError.message : String(readError),
          });
        }
      }

      return {
        scope,
        file,
        diff: result.diff,
        additions: result.additions,
        deletions: result.deletions,
      };
    } catch (error) {
      rethrowForRest(error);
    }
  },
});
