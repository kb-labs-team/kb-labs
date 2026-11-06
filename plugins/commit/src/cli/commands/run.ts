/**
 * commit command (default flow)
 * Generate → Apply → (optional) Push
 */

import {
  defineCommand,
  useLLM,
  useLoader,
  useConfig,
  findRepoRoot,
  handleError,
  AdapterUnavailableError,
  type PluginCommandContextV3,
  type CLIInput,
} from '@kb-labs/sdk';
import type { CommandResult } from '@kb-labs/sdk';
import {
  generateCommitPlan,
  savePlan,
  hasChanges,
  getGitStatus,
  applyCommitPlan,
  pushCommits,
  saveToHistory,
  clearPlan,
} from '../../core/index.js';
import {
  type CommitRunOutput,
  type CommitPluginConfig,
  resolveCommitConfig,
  type CommitFlags,
  commitEnv,
} from '../../contracts/index.js';
import { resolveScopePath } from '../../rest/handlers/scope-resolver';

type RunResult = CommandResult<CommitRunOutput>;

async function resolveContext(ctx: PluginCommandContextV3, flags: CommitFlags) {
  const llm = useLLM();
  const cwd = (await findRepoRoot(ctx.cwd || process.cwd())) ?? process.cwd();
  const fileConfig = await useConfig<Partial<CommitPluginConfig>>();
  const env = commitEnv.parse(ctx.runtime);
  const config = resolveCommitConfig(fileConfig ?? {}, env);
  const effectiveScope = flags.scope ?? config.scope?.default ?? 'root';
  const scopeCwd = resolveScopePath(cwd, effectiveScope, config.scope?.scopes);
  const rawPlatformConfig = await ctx.platform.config.getRawConfig();
  const llmConfigured = hasConfiguredLLM(rawPlatformConfig);

  if (config.llm.enabled && !llmConfigured) {
    throw new AdapterUnavailableError('llm');
  }

  const llmComplete =
    llm && config.llm.enabled && llmConfigured
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

  return { cwd, config, effectiveScope, scopeCwd, llmComplete };
}

function hasConfiguredLLM(config: unknown): boolean {
  if (typeof config !== 'object' || config === null) {
    return false;
  }
  const platform = (config as Record<string, unknown>).platform;
  if (typeof platform !== 'object' || platform === null) {
    return false;
  }
  const adapters = (platform as Record<string, unknown>).adapters;
  if (typeof adapters !== 'object' || adapters === null) {
    return false;
  }
  const llm = (adapters as Record<string, unknown>).llm;
  return typeof llm === 'string' ? llm.trim().length > 0 : Array.isArray(llm) && llm.length > 0;
}

function createEmptyCommitPlan(
  repoRoot: string,
  gitStatus: CommitRunOutput['plan']['gitStatus'],
): CommitRunOutput['plan'] {
  return {
    schemaVersion: '1.0',
    createdAt: new Date().toISOString(),
    repoRoot,
    gitStatus,
    commits: [],
    metadata: { totalFiles: 0, totalCommits: 0, llmUsed: false, escalated: false, tokensUsed: 0 },
  };
}

function renderPreview(
  ctx: PluginCommandContextV3,
  plan: CommitRunOutput['plan'],
  effectiveScope: string,
  outputJson: boolean,
  startTime: number,
): RunResult {
  const output: CommitRunOutput = { plan, applied: false, pushed: false, commits: [] };

  if (outputJson) {
    return output;
  } else {
    const items = plan.commits.map(c => `${c.type}${c.scope ? `(${c.scope})` : ''}: ${c.message}`);
    ctx.ui?.success?.(plan.commits.length === 0 ? 'No changes to commit' : 'Commit plan generated (dry-run)', {
      title: 'Git Commit',
      sections: [
        ...(items.length > 0 ? [{ header: 'Planned Commits', items }] : []),
        { header: 'Result', items: [items.length === 0 ? 'No commits planned' : `Commits: ${items.length}`, 'Applied: No', `Scope: ${effectiveScope}`] },
      ],
      timing: Date.now() - startTime,
    });
  }

  return output;
}

export default defineCommand({
  id: 'commit:commit',
  description: 'Generate and apply commits (default flow)',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: CLIInput<CommitFlags>): Promise<RunResult> {
      const startTime = Date.now();
      const flags = input.flags;
      const { cwd, effectiveScope, scopeCwd, llmComplete, config } = await resolveContext(ctx, flags);
      const withPush = flags['with-push'] ?? false;
      const outputJson = flags.json ?? false;

      // 1. Check for changes
      const statusLoader = useLoader('Checking git status...');
      statusLoader.start();
      let status;
      try {
        status = await getGitStatus(scopeCwd);
      } catch (err) {
        statusLoader.fail('Failed to check git status');
        return handleError(err);
      }

      if (!hasChanges(status)) {
        statusLoader.stop();
        return renderPreview(ctx, createEmptyCommitPlan(scopeCwd, status), effectiveScope, outputJson, startTime);
      }
      statusLoader.succeed('Git status analyzed');

      // 2. Generate plan
      const analyzeLoader = useLoader('Analyzing changes...');
      analyzeLoader.start();

      const plan = await generateCommitPlan({
        cwd: scopeCwd,
        llmComplete,
        config,
        allowSecrets: flags['allow-secrets'] ?? false,
        autoConfirm: flags.yes ?? false,
        onOutput: (message) => ctx.ui?.write?.(message),
        onProgress: (message) => analyzeLoader.update({ text: message }),
        onPauseProgress: () => analyzeLoader.stop(),
        onResumeProgress: () => analyzeLoader.start(),
      });

      analyzeLoader.succeed(`Generated commit plan with ${plan.commits.length} commit(s)`);

      if (flags['dry-run']) {
        return renderPreview(ctx, plan, effectiveScope, outputJson, startTime);
      }

      await savePlan(cwd, plan);

      // 3. Apply plan
      const applyLoader = useLoader('Applying commits...');
      applyLoader.start();
      const applyResult = await applyCommitPlan(scopeCwd, plan);

      if (!applyResult.success) {
        applyLoader.fail('Failed to apply commits');
        if (!outputJson) {

        }
        return {
          ok: false,
          error: { code: 'KB_RUNTIME_COMMAND_FAILED', message: 'Commit plan could not be applied. Review the Git errors above, resolve them, then rerun `kb commit plan apply`.', hint: 'Run `kb commit --help` to review the command inputs, then rerun the command.' },
        };
      }

      await saveToHistory(cwd, plan, applyResult);
      await clearPlan(cwd);
      applyLoader.succeed(`Applied ${applyResult.appliedCommits.length} commit(s)`);

      // 4. Push (optional)
      let pushed = false;
      if (withPush) {
        const pushLoader = useLoader('Pushing commits...');
        pushLoader.start();
        const pushResult = await pushCommits(scopeCwd);

        if (pushResult.success) {
          pushed = true;
          pushLoader.succeed(`Pushed to ${pushResult.remote}/${pushResult.branch}`);
        } else {
          pushLoader.fail(`Failed to push: ${pushResult.error}`);
        }
      }

      const output: CommitRunOutput = {
        plan,
        applied: true,
        pushed,
        commits: applyResult.appliedCommits.map((c) => ({
          id: c.groupId,
          sha: c.sha,
          message: c.message,
        })),
      };

      if (outputJson) {
        return output;
      } else {
        const commitsItems = applyResult.appliedCommits.map((c) => {
          const shortSha = c.sha.substring(0, 7);
          const firstLine = c.message.split('\n')[0];
          return `[${shortSha}] ${firstLine}`;
        });

        const summaryItems: string[] = [
          `Commits: ${applyResult.appliedCommits.length}`,
          `Pushed: ${pushed ? 'Yes' : 'No'}`,
          `Scope: ${effectiveScope}`,
        ];

        if (plan.metadata.llmUsed) {
          const llmPhase = plan.metadata.escalated ? 'Phase 2' : 'Phase 1';
          summaryItems.push(`LLM: ${llmPhase}`);
          if (plan.metadata.tokensUsed) {
            summaryItems.push(`Tokens: ${plan.metadata.tokensUsed}`);
          }
        }

        const timing = Date.now() - startTime;
        ctx.ui?.success?.('Commits created successfully', {
          title: 'Git Commit',
          sections: [
            { header: 'Summary', items: summaryItems },
            { header: 'Commits Created', items: commitsItems },
          ],
          timing,
        });
      }

      return output;
    },
  },
});
