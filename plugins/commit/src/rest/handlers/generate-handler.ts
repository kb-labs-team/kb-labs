import { defineHandler, useConfig, useLLM, type PluginContextV3, type RestInput, rethrowForRest } from '@kb-labs/sdk';
import {
  COMMIT_CACHE_PREFIX,
  type GenerateRequest,
  type GenerateResponse,
  type CommitPluginConfig,
  resolveCommitConfig,
} from '../../contracts/index.js';
import { generateCommitPlan } from '../../core/generator/index.js';
import { savePlan, getCurrentPlanPath } from '../../core/storage/index.js';
import { isSecretsDetectedError } from '../../core/analyzer/index.js';
import { resolveScopePath } from './scope-resolver';

/**
 * POST /generate handler
 *
 * Generates a new commit plan for the given scope.
 * Uses LLM to analyze changes and group into conventional commits.
 */
export default defineHandler({
  async execute(ctx: PluginContextV3, input: RestInput<unknown, GenerateRequest>): Promise<GenerateResponse> {
    const { scope = 'root', dryRun, allowSecrets = false, autoConfirm = false } = input.body ?? {};
    const startTime = Date.now();

    try {
      const fileConfig = await useConfig<Partial<CommitPluginConfig>>();
      const config = resolveCommitConfig(fileConfig ?? {});
      const scopeCwd = resolveScopePath(ctx.cwd, scope, config.scope?.scopes);

      const llm = useLLM();
      const llmComplete =
        llm && config.llm.enabled
          ? async (prompt: string, options?: { systemPrompt?: string; temperature?: number; maxTokens?: number }) => {
              const result = await llm.complete(prompt, {
                ...options,
                temperature: options?.temperature ?? config.llm.temperature,
                maxTokens: options?.maxTokens ?? config.llm.maxTokens,
              });
              return {
                content: result.content,
                tokensUsed: result.usage ? result.usage.promptTokens + result.usage.completionTokens : undefined,
              };
            }
          : undefined;

      const plan = await generateCommitPlan({
        cwd: scopeCwd,
        llmComplete,
        config,
        allowSecrets,
        autoConfirm,
        onOutput: (message) => ctx.ui?.write?.(message),
        onProgress: (message) => {
        },
      });

      let planPath = '';

      // Save plan unless dry-run
      if (!dryRun) {
        await savePlan(ctx.cwd, plan, scope);
        planPath = getCurrentPlanPath(ctx.cwd, scope);

        // New plan invalidates previously applied state for this scope.
        const appliedCacheKey = `${COMMIT_CACHE_PREFIX}plan-applied:${scope}`;
        await ctx.platform.cache.delete(appliedCacheKey);
      }

      // Track success
      if (ctx.platform.analytics) {
        await ctx.platform.analytics.track('commit.plan.generated', {
          scope,
          dryRun,
          filesChanged: plan.metadata.totalFiles,
          commitsGenerated: plan.metadata.totalCommits,
          llmUsed: plan.metadata.llmUsed,
          tokensUsed: plan.metadata.tokensUsed,
          escalated: plan.metadata.escalated,
          durationMs: Date.now() - startTime,
        });
      }

      return {
        success: true,
        plan,
        planPath,
        scope,
        secretsDetected: false,
      };
    } catch (error) {
      // Handle secrets detection specially - return structured response instead of throwing
      if (isSecretsDetectedError(error)) {
        // Track secrets detected event
        if (ctx.platform.analytics) {
          await ctx.platform.analytics.track('commit.secrets.detected', {
            scope,
            secretCount: error.secretMatches.length,
            durationMs: Date.now() - startTime,
          });
        }

        // Return structured response with secrets info
        return {
          success: false,
          scope,
          secretsDetected: true,
          secrets: error.secretMatches.map((match) => ({
            file: match.file,
            line: match.line,
            column: match.column,
            type: match.patternName,
            pattern: match.pattern,
            matched: match.matchedText,
            context: match.snippet,
          })),
          message: error.message,
        };
      }

      // Track other errors
      if (ctx.platform.analytics) {
        await ctx.platform.analytics.track('commit.plan.error', {
          scope,
          dryRun,
          error: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - startTime,
        });
      }

      rethrowForRest(error);
    }
  },
});
