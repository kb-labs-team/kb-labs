/**
 * commit:generate command
 * Generate commit plan from git changes
 */

import {
  defineCommand,
  useLLM,
  useLoader,
  useConfig,
  findRepoRoot,
  displayArtifacts,
  handleError,
  AdapterCredentialsMissingError,
  AdapterUnavailableError,
  type PluginCommandContextV3,
  type CommandResult,
  type ArtifactInfo,
} from '@kb-labs/sdk';
import { stat } from 'node:fs/promises';
import {
  generateCommitPlan,
  savePlan,
  hasChanges,
  getGitStatus,
  getCurrentPlanPath,
} from '../../core/index.js';
import {
  type GenerateOutput,
  type CommitPluginConfig,
  resolveCommitConfig,
  type GenerateFlags,
  commitEnv,
} from '../../contracts/index.js';
import { resolveScopePath } from '../../rest/handlers/scope-resolver';

// Input type with V3 handler compatibility
// V3 handlers receive flags either in input.flags (CLI) or directly in input (REST API)
type GenerateInput = GenerateFlags & {
  argv?: string[];
  flags?: GenerateFlags;
};

type GenerateResult = CommandResult<GenerateOutput>;

export default defineCommand({
  id: 'commit:generate',
  description: 'Generate commit plan from git changes',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: GenerateInput): Promise<GenerateResult> {
      const startTime = Date.now();
      const flags = input.flags ?? input;
      const llm = useLLM();
      const cwd = (await findRepoRoot(ctx.cwd || process.cwd())) ?? process.cwd();

      // Load config from kb.config.json + env overrides
      const fileConfig = await useConfig<Partial<CommitPluginConfig>>();

      // V3: Parse env variables with type safety and validation
      const env = commitEnv.parse(ctx.runtime);

      const config = resolveCommitConfig(fileConfig ?? {}, env);

      // V3: Flags come in input.flags (CLI) or directly in input (REST API)
      const effectiveScope = flags.scope ?? config.scope?.default ?? 'root';
      const scopeCwd = resolveScopePath(cwd, effectiveScope, config.scope?.scopes);
      const allowSecrets = flags['allow-secrets'] ?? false;
      const autoConfirm = flags.yes ?? false;

      // Check for changes (with scope for nested repos)
      const statusLoader = useLoader('Checking git status...');
      if (!flags.json) { statusLoader.start(); }
      const status = await getGitStatus(scopeCwd);

      if (!hasChanges(status)) {
        if (!flags.json) {
          statusLoader.stop();
          ctx.ui?.warn?.('No changes to commit');
        }
        return { ok: false, error: { code: 'KB_RUNTIME_COMMAND_FAILED', message: 'No changes to commit', hint: 'Run `kb commit --help` to review the command inputs, then rerun the command.' } };
      }
      if (!flags.json) { statusLoader.succeed('Found changes to commit'); }

      // Generate plan
      const analyzeLoader = useLoader('Analyzing changes...');
      if (!flags.json) { analyzeLoader.start(); }

      // Create LLM wrapper with config values
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

      let plan;
      try {
        plan = await generateCommitPlan({
          cwd: scopeCwd,
          llmComplete,
          config,
          allowSecrets,
          autoConfirm,
          onOutput: (message) => ctx.ui?.write?.(message),
          onProgress: (message) => { if (!flags.json) { analyzeLoader.update({ text: message }); } },
        });
      } catch (err) {
        if (!flags.json) { analyzeLoader.fail('Failed to generate commit plan'); }
        if ((err instanceof AdapterUnavailableError && err.reason === 'not-configured') || err instanceof AdapterCredentialsMissingError) {
          return handleError(err);
        }
        return handleError(err);
      }

      // Save plan
      const saveLoader = useLoader('Saving plan...');
      if (!flags.json) { saveLoader.start(); }
      try {
        await savePlan(cwd, plan, effectiveScope);
      } catch (err) {
        if (!flags.json) { saveLoader.fail('Failed to save plan'); }
        return handleError(err);
      }
      const planPath = getCurrentPlanPath(cwd, effectiveScope);
      if (!flags.json) { saveLoader.succeed('Plan saved'); }

      if (!flags.json) { analyzeLoader.succeed(`Generated commit plan with ${plan.commits.length} commit(s)`); }

      // Output
      const output: GenerateOutput = {
        plan,
        planPath,
      };

      // V3: Flags are auto-merged by bootstrap.ts, just use directly
      if (flags.json) {
        return output;
      } else {
        // Build commits section
        const commitsItems = plan.commits.map((commit) => {
          const scope = commit.scope ? `(${commit.scope})` : '';
          return `${commit.type}${scope}: ${commit.message} [${commit.files.length} file(s)]`;
        });

        // Build artifacts section
        const artifacts: ArtifactInfo[] = [];
        try {
          const planStats = await stat(planPath);
          artifacts.push({
            name: 'Commit Plan',
            path: planPath,
            size: planStats.size,
            modified: planStats.mtime,
            description: 'Generated commit plan in JSON format',
          });
        } catch {
          // Ignore stat errors
        }

        const sections: Array<{ header?: string; items: string[] }> = [];

        // Add commits section
        if (commitsItems.length > 0) {
          sections.push({
            header: 'Commits',
            items: commitsItems,
          });
        }

        // Add artifacts section
        if (artifacts.length > 0) {
          const artifactsLines = displayArtifacts(artifacts, {
            showSize: true,
            showTime: true,
            showDescription: true,
            maxItems: 10,
            title: '',
          });
          sections.push({
            header: 'Artifacts',
            items: artifactsLines,
          });
        }

        // Build summary section
        const summaryItems: string[] = [
          `Files: ${plan.metadata.totalFiles}`,
          `Commits: ${plan.metadata.totalCommits}`,
        ];

        if (plan.metadata.llmUsed) {
          const llmPhase = plan.metadata.escalated ? 'Phase 2 (with diff)' : 'Phase 1';
          summaryItems.push(`LLM: ${llmPhase}`);
          if (plan.metadata.tokensUsed) {
            summaryItems.push(`Tokens: ${plan.metadata.tokensUsed}`);
          }
        } else {
          summaryItems.push('Generator: Heuristics');
        }

        sections.unshift({
          header: 'Summary',
          items: summaryItems,
        });

        const timing = Date.now() - startTime;

        ctx.ui?.success?.('Plan generated and saved', {
          title: 'Generate Commit Plan',
          sections,
          timing,
        });
      }

      return output;
    },
  },
});
