import { defineHandler, useConfig, type PluginContextV3, type RestInput, useLogger, useLLM, rethrowForRest } from '@kb-labs/sdk';
import { type SummarizeRequest, type SummarizeResponse, type CommitPluginConfig, resolveCommitConfig } from '../../contracts/index.js';
import { getFileDiff, getAllChangedFiles, getGitStatus } from '../../core/analyzer/index.js';
import { resolveScopePath } from './scope-resolver';

/**
 * POST /summarize handler
 *
 * Summarizes changes using LLM. Can summarize:
 * - All changes in scope (if no file specified)
 * - Specific file changes (if file specified)
 */
export default defineHandler({
  async execute(ctx: PluginContextV3, input: RestInput<unknown, SummarizeRequest>): Promise<SummarizeResponse> {
    const logger = useLogger();
    const llm = useLLM();

    if (!llm) {
      throw new Error('LLM is not available. Please configure an LLM adapter.');
    }

    const { scope = 'root', file } = input.body || {};

    logger.info('[summarize-handler] Request received', { scope, file });

    try {
      // Resolve scope to actual directory path
      const fileConfig = await useConfig<Partial<CommitPluginConfig>>();
      const config = resolveCommitConfig(fileConfig ?? {});
      const scopeCwd = resolveScopePath(ctx.cwd, scope, config.scope?.scopes);
      logger.info('[summarize-handler] Resolved scope', { scope, scopeCwd });

      let prompt: string;

      if (file) {
        // Summarize specific file
        logger.info('[summarize-handler] Summarizing file', { file });

        // Get file diff (git runs FROM scopeCwd)
        const diffResult = await getFileDiff(scopeCwd, file);

        prompt = `Analyze this git diff and provide a concise summary of what changed in this file.

File: ${file}

Diff:
\`\`\`diff
${diffResult.diff}
\`\`\`

Provide a 2-3 sentence summary focusing on:
- What was added, modified, or removed
- The purpose/intent of the changes
- Any notable impacts

Keep it concise and technical.`;
      } else {
        // Summarize all changes
        logger.info('[summarize-handler] Summarizing all changes');

        // Get git status (git runs FROM scopeCwd)
        const gitStatus = await getGitStatus(scopeCwd);
        const files = getAllChangedFiles(gitStatus);

        if (files.length === 0) {
          return {
            scope,
            summary: 'No changes detected in this scope.',
          };
        }

        // Get diffs for all files (limit to first 10 to avoid token overflow)
        const filesToSummarize = files.slice(0, 10);
        const diffs = await Promise.all(
          filesToSummarize.map(async (f) => {
            const diff = await getFileDiff(scopeCwd, f);
            return { file: f, diff: diff.diff, additions: diff.additions, deletions: diff.deletions };
          })
        );

        const diffsText = diffs
          .map((d) => `### ${d.file} (+${d.additions} -${d.deletions})\n\`\`\`diff\n${d.diff}\n\`\`\``)
          .join('\n\n');

        prompt = `Analyze these git diffs and provide a high-level summary of all changes in this scope.

Total files changed: ${files.length}
${files.length > 10 ? `(Showing first 10 files)` : ''}

${diffsText}

Provide a 3-5 sentence summary covering:
- Overall theme of the changes
- Key features added, bugs fixed, or refactorings done
- Any notable architectural changes

Keep it concise and at a high level.`;
      }

      // Call LLM
      logger.info('[summarize-handler] Calling LLM');
      const result = await llm.complete(prompt, {
        systemPrompt: 'You are a technical code reviewer. Provide concise, accurate summaries of code changes.',
        temperature: 0.3,
        maxTokens: 500,
      });

      logger.info('[summarize-handler] LLM response received', {
        tokensUsed: result.usage.promptTokens + result.usage.completionTokens,
      });

      return {
        scope,
        file,
        summary: result.content.trim(),
        tokensUsed: result.usage.promptTokens + result.usage.completionTokens,
      };
    } catch (error) {
      logger.error('[summarize-handler] Error', error as Error);
      rethrowForRest(error);
    }
  },
});
