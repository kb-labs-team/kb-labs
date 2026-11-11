import { defineHandler, useConfig, type PluginContextV3, type RestInput, useLLM, useLogger, rethrowForRest } from '@kb-labs/sdk';
import type { LLMMessage } from '@kb-labs/sdk';
import {
  COMMIT_CACHE_PREFIX,
  type RegenerateCommitRequest,
  type RegenerateCommitResponse,
  type CommitGroup,
  type CommitPluginConfig,
  resolveCommitConfig,
} from '../../contracts/index.js';
import { loadPlan, savePlan } from '../../core/storage/index.js';
import { getFileSummaries, getFileDiffs } from '../../core/analyzer/index.js';
import { COMMIT_PLAN_TOOL, SYSTEM_PROMPT_WITH_DIFF } from '../../core/generator/index.js';
import { resolveScopePath } from './scope-resolver';

/**
 * POST /regenerate-commit handler
 *
 * Re-analyzes files from a single commit using LLM and replaces it in the plan.
 * Uses Phase 2 approach (with diff context) for best results.
 */
export default defineHandler({
  async execute(ctx: PluginContextV3, input: RestInput<unknown, RegenerateCommitRequest>): Promise<RegenerateCommitResponse> {
    const logger = useLogger();
    const { scope = 'root', commitId, instruction } = input.body ?? {};

    if (!commitId) {
      throw new Error('commitId is required');
    }

    const plan = await loadPlan(ctx.cwd, scope);
    if (!plan) {
      throw new Error('No commit plan found. Generate a plan first.');
    }

    const commitIndex = plan.commits.findIndex(c => c.id === commitId);
    if (commitIndex === -1) {
      throw new Error(`Commit "${commitId}" not found in plan`);
    }

    const existingCommit = plan.commits[commitIndex]!;
    const files = existingCommit.files;

    if (files.length === 0) {
      throw new Error('Commit has no files to regenerate');
    }

    const llm = useLLM();
    if (!llm || !llm.chatWithTools) {
      throw new Error('LLM is not available for regeneration');
    }

    try {
      // Resolve scope for file operations
      const fileConfig = await useConfig<Partial<CommitPluginConfig>>();
      const config = resolveCommitConfig(fileConfig ?? {});
      const scopeCwd = resolveScopePath(ctx.cwd, scope, config.scope?.scopes);

      // Get fresh file summaries and diffs
      const summaries = await getFileSummaries(scopeCwd, files);
      const diffs = await getFileDiffs(scopeCwd, files);

      // Build prompt for single commit regeneration
      const fileContext = summaries.map(s => {
        const diff = diffs.get(s.path) || '';
        return `File: ${s.path} (${s.status}, +${s.additions}/-${s.deletions})${diff ? `\nDiff:\n${diff}` : ''}`;
      }).join('\n\n');

      const instructionText = instruction
        ? `\n\nUser instruction: ${instruction}`
        : '';

      const userPrompt = `Analyze these files and generate exactly ONE commit following conventional commit conventions.
These files were previously grouped as: ${existingCommit.type}(${existingCommit.scope || ''}): ${existingCommit.message}

Re-analyze them and generate an improved commit message.${instructionText}

Files to analyze:
${fileContext}`;

      const messages: LLMMessage[] = [
        { role: 'system', content: SYSTEM_PROMPT_WITH_DIFF },
        { role: 'user', content: userPrompt },
      ];

      const response = await llm.chatWithTools(messages, {
        tools: [COMMIT_PLAN_TOOL],
        toolChoice: {
          type: 'function',
          function: { name: 'generate_commit_plan' },
        },
        temperature: 0.3,
      });

      const toolCall = response.toolCalls?.[0];
      if (!toolCall || toolCall.name !== 'generate_commit_plan') {
        throw new Error('LLM did not call generate_commit_plan tool');
      }

      const toolArgs = toolCall.input as { commits: CommitGroup[] };

      // Take the first commit from LLM output (we asked for exactly one)
      const regeneratedCommit = toolArgs.commits[0];
      if (!regeneratedCommit) {
        throw new Error('LLM returned no commits');
      }

      // Preserve the original commit ID and files
      regeneratedCommit.id = existingCommit.id;
      regeneratedCommit.files = existingCommit.files;

      // Replace in plan
      plan.commits[commitIndex] = regeneratedCommit;
      await savePlan(ctx.cwd, plan, scope);

      // Regenerated plan is no longer considered applied.
      const appliedCacheKey = `${COMMIT_CACHE_PREFIX}plan-applied:${scope}`;
      await ctx.platform.cache.delete(appliedCacheKey);

      await logger.info('[regenerate-handler] Commit regenerated', {
        scope,
        commitId,
        oldMessage: `${existingCommit.type}: ${existingCommit.message}`,
        newMessage: `${regeneratedCommit.type}: ${regeneratedCommit.message}`,
      });

      // Track analytics
      if (ctx.platform.analytics) {
        await ctx.platform.analytics.track('commit.regenerate.success', {
          scope,
          commitId,
          hadInstruction: !!instruction,
          filesCount: files.length,
        });
      }

      return {
        success: true,
        scope,
        commitId,
        commit: regeneratedCommit,
      };
    } catch (error) {
      if (ctx.platform.analytics) {
        await ctx.platform.analytics.track('commit.regenerate.error', {
          scope,
          commitId,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      rethrowForRest(error);
    }
  },
});
