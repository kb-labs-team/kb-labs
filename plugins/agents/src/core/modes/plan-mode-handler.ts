/**
 * Plan mode handler - lightweight "Claude Code style" planning flow.
 *
 * Core behavior:
 * - Reuse regular Agent loop (research + tool use).
 * - Restrict tool access to read-only/discovery/reporting tools.
 * - Ask agent to output a markdown plan (free-form, human-oriented).
 * - Persist plan as session plan.json + canonical markdown document.
 */

import type {
  AgentConfig,
  AgentEvent,
  KernelState,
  TaskPlan,
  TaskResult,
  PlanContext,
} from '../../contracts/index.js';
import type { ToolRegistry } from '../../tools/index.js';
import { createToolRegistry, PLAN_READ_ONLY_TOOL_NAMES } from '../../tools/index.js';
import type { ModeHandler } from './mode-handler';
import { AgentSDK, type IAgentRunner } from '../../sdk/index.js';
import { createDefaultResponseRequirementsSelector } from '../../runtime/index.js';
import { createCoreToolPack } from '../tools/index.js';
import { SessionManager } from '../planning/session-manager';
import { PlanDocumentService } from '../planning/plan-document-service.js';
import { TaskMiddleware } from '../middleware/builtin/task-middleware';
import { createPlanRuntimeProfile } from './plan-profile.js';
import { promises as fs } from 'node:fs';
import { createSessionMemoryBridge } from '../core/session-memory-bridge.js';

class SharedTokenBudget {
  private consumed = 0;

  constructor(private readonly total: number) {}

  get remaining(): number {
    return Math.max(0, this.total - this.consumed);
  }

  get used(): number {
    return Math.max(0, this.consumed);
  }

  allocate(requested: number, minimum = 3000): number {
    const requestedSafe = Number.isFinite(requested) ? Math.max(minimum, Math.floor(requested)) : minimum;
    if (this.remaining <= 0) {return 0;}
    return Math.min(this.remaining, requestedSafe);
  }

  consume(tokensUsed: number): void {
    if (!Number.isFinite(tokensUsed) || tokensUsed <= 0) {return;}
    this.consumed += Math.floor(tokensUsed);
  }
}


export class PlanModeHandler implements ModeHandler {
  async execute(
    task: string,
    config: AgentConfig,
    toolRegistry: ToolRegistry,
  ): Promise<TaskResult> {
    const startedAt = new Date().toISOString();
    const startMs = Date.now();
    const sessionManager = new SessionManager(config.workingDir);
    const sessionId = config.sessionId || `session-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const planContext = config.mode?.context as PlanContext | undefined;
    const complexity = planContext?.complexity || 'medium';
    const enableDelegation = shouldEnablePlanDelegation(task, complexity);
    const allowedPlanTools = buildPlanAllowedTools(enableDelegation);
    const existingPlanPath = sessionManager.getSessionPlanPath(sessionId);
    const existingPlan = config.sessionId ? await this.loadPlan(existingPlanPath) : null;
    const planProfile = createPlanRuntimeProfile({
      workingDir: config.workingDir,
      sessionManager,
      task,
      complexity,
      existingPlan,
    });
    const complexityDefault = complexity === 'simple' ? 20 : complexity === 'complex' ? 40 : 30;
    // Plan mode caps iterations — token budget is the real control, not iterations.
    // Always reserve at least 3 iterations for plan_validate + report + one retry,
    // so exploration never consumes the entire budget.
    const SYNTHESIS_RESERVE = 3;
    const effectiveMaxIterations = Math.min(config.maxIterations, Math.max(10, complexityDefault));
    const totalPlanBudget = Math.max(
      10_000,
      Math.floor(config.tokenBudget?.maxTokens ?? 1_000_000),
    );
    const sharedBudget = new SharedTokenBudget(totalPlanBudget);
    const explorationBudget = effectiveMaxIterations - SYNTHESIS_RESERVE;
    const planTaskPrompt = this.buildPlanPrompt(
      task,
      existingPlan?.markdown,
      effectiveMaxIterations,
      explorationBudget,
      sharedBudget.remaining,
      totalPlanBudget,
      enableDelegation,
    );
    const budgetSnapshot = () => this.buildBudgetSnapshot(sharedBudget, totalPlanBudget);

    this.emit(config, {
      type: 'status:change',
      timestamp: new Date().toISOString(),
      sessionId,
      data: {
        status: 'planning',
        message: 'Plan mode enabled: read-only exploration + markdown plan drafting',
        ...budgetSnapshot(),
      },
    });
    this.emit(config, {
      type: 'progress:update',
      timestamp: new Date().toISOString(),
      sessionId,
      data: {
        phase: 'plan',
        progress: 10,
        message: existingPlan ? 'Revising existing plan draft' : 'Generating new plan draft',
        ...budgetSnapshot(),
      },
    });

    try {
      // Build the plan-writer's toolRegistry with:
      // - allowedTools: read-only set + task_submit/task_status/task_collect for async delegation
      // - taskManager: TaskMiddleware that spawns read-only research sub-agents
      //   Sub-agents get allowedTools=PLAN_READ_ONLY_TOOL_NAMES but no taskManager
      //   → task tools won't register for them → no recursion.
      const planTaskMw = enableDelegation ? new TaskMiddleware({ maxConcurrent: 5 }) : undefined;
      const responseRequirementsSelector = createDefaultResponseRequirementsSelector();
      planTaskMw?.setSpawnFn(async (request) => {
        const researchRegistry = createToolRegistry({
          ...toolRegistry.getContext(),
          currentTask: request.task,
          allowedTools: allowedPlanTools,
          sessionMemory: createSessionMemoryBridge(
            request.workingDir ?? config.workingDir,
            config.sessionId,
          ),
          responseRequirementsResolver: async ({ task, kernel }: {
            task?: string;
            answer: string;
            kernel: KernelState | null;
          }) =>
            responseRequirementsSelector.select({
              state: kernel,
              messages: [],
              task: task ?? request.task,
            }),
          // no taskManager → task tools not registered → no recursion
        });
        const researchRunner = this.createSubRunner(
          {
            ...config,
            mode: undefined,
            maxIterations: request.maxIterations ?? Math.min(15, Math.max(5, Math.floor(effectiveMaxIterations * 0.25))),
            workingDir: request.workingDir ?? config.workingDir,
            tokenBudget: {
              ...config.tokenBudget,
              enabled: true,
              maxTokens: sharedBudget.allocate(Math.floor(sharedBudget.remaining * 0.30), 4000),
              softLimitRatio: 0.75,
              hardLimitRatio: 0.95,
              hardStop: true,
              forceSynthesisOnHardLimit: true,
              allowIterationBudgetExtension: false,
            },
            onEvent: config.onEvent,
          },
          researchRegistry,
        );
        const startedAt = Date.now();
        const result = await researchRunner.execute(request.task);
        sharedBudget.consume(result.tokensUsed);
        return {
          success: result.success,
          summary: result.summary,
          filesRead: result.filesRead,
          filesModified: result.filesModified,
          filesCreated: result.filesCreated,
          iterations: result.iterations,
          tokensUsed: result.tokensUsed,
          durationMs: Date.now() - startedAt,
          error: result.error,
          preset: request.preset ?? 'research' as const,
        };
      });

      const planWriterRegistry = createToolRegistry({
        ...toolRegistry.getContext(),
        currentTask: task,
        allowedTools: allowedPlanTools,
        taskManager: planTaskMw,
        sessionMemory: createSessionMemoryBridge(config.workingDir, sessionId),
        responseRequirementsResolver: async ({ task: activeTask, kernel }: {
          task?: string;
          answer: string;
          kernel: KernelState | null;
        }) =>
          responseRequirementsSelector.select({
            state: kernel,
            messages: [],
            task: activeTask ?? task,
          }),
      });

      const budgetAwarePrompt = `${planTaskPrompt}\nCURRENT TOKEN BUDGET: ${sharedBudget.remaining}/${totalPlanBudget} tokens remaining. Be concise, avoid redundant exploration, and prioritize executable plan output.`;
      let reportedPlanText = '';
      const childOnEvent: AgentConfig['onEvent'] = (event) => {
        if (event.type === 'tool:end' && event.data?.toolName === 'report') {
          const metadataAnswer = (event.data?.metadata as { answer?: unknown } | undefined)?.answer;
          const output = typeof event.data?.output === 'string' ? event.data.output : '';
          const answer = typeof metadataAnswer === 'string' ? metadataAnswer : '';
          const captured = answer.trim() || output.trim();
          if (captured) {
            reportedPlanText = captured;
          }
        }
        if (event.type === 'llm:end') {
          const content = typeof event.data?.content === 'string' ? event.data.content.trim() : '';
          if (content && /^#{1,3}\s+/m.test(content) && content.length > 200) {
            reportedPlanText = content;
          }
        }
        config.onEvent?.(event);
      };
      const planRunner = this.createSubRunner(
        {
          ...config,
          sessionId,
          mode: undefined,
          maxIterations: effectiveMaxIterations,
          tokenBudget: {
            ...config.tokenBudget,
            enabled: true,
            maxTokens: sharedBudget.allocate(Math.max(8_000, Math.floor(sharedBudget.remaining * 0.9)), 8000),
            softLimitRatio: config.tokenBudget?.softLimitRatio ?? 0.40,
            hardLimitRatio: config.tokenBudget?.hardLimitRatio ?? 0.95,
            hardStop: config.tokenBudget?.hardStop ?? true,
            forceSynthesisOnHardLimit: config.tokenBudget?.forceSynthesisOnHardLimit ?? true,
            restrictBroadExplorationAtSoftLimit:
              config.tokenBudget?.restrictBroadExplorationAtSoftLimit ?? true,
            allowIterationBudgetExtension: false,
          },
          onEvent: childOnEvent,
        },
        planWriterRegistry,
        planProfile,
      );

      const planningResult = await planRunner.execute(budgetAwarePrompt);
      sharedBudget.consume(planningResult.tokensUsed);
      const plan = planningResult.plan ?? this.buildFallbackPlan(sessionId, task, complexity, reportedPlanText || planningResult.summary, existingPlan);
      const runtimeCompletion = (planningResult.metrics?.runtimeCompletion as {
        blockedByPolicy?: boolean;
        validationResults?: Array<{ verdict: 'allow' | 'warn' | 'block'; rationale: string }>;
      } | undefined);
      const blockingValidation = runtimeCompletion?.validationResults?.find((result) => result.verdict === 'block');
      const validation = {
        passed: !runtimeCompletion?.blockedByPolicy,
        summary: blockingValidation?.rationale ?? 'Plan validation passed.',
      };
      const incomplete = plan.status === 'failed';

      if (incomplete || !validation.passed) {
        plan.status = 'failed';
      }

      this.emit(config, {
        type: 'progress:update',
        timestamp: new Date().toISOString(),
        sessionId,
        data: {
          phase: 'plan',
          progress: 78,
          message: incomplete
            ? 'Plan generation incomplete'
            : validation.passed
              ? 'Plan draft validated, persisting artifacts'
              : `Plan draft failed final validation: ${validation.summary}`,
          ...budgetSnapshot(),
        },
      });

      const planPath = sessionManager.getSessionPlanPath(sessionId);
      const documentPath = new PlanDocumentService(config.workingDir).getPlanPath(plan);
      const artifactPaths = [planPath, documentPath];
      const phaseCount = plan.phases.length;
      const stepCount = plan.phases.reduce((sum, phase) => sum + phase.steps.length, 0);

      if (incomplete || !validation.passed) {
        this.emit(config, {
          type: 'status:change',
          timestamp: new Date().toISOString(),
          sessionId,
          data: {
            status: 'error',
            message: incomplete
              ? 'Plan generation incomplete — agent did not produce a structured plan'
              : `Plan failed deterministic validation — ${validation.summary}`,
            ...budgetSnapshot(),
          },
        });
        this.emit(config, {
          type: 'progress:update',
          timestamp: new Date().toISOString(),
          sessionId,
          data: {
            phase: 'plan',
            progress: 100,
            message: 'Plan mode complete (incomplete)',
            ...budgetSnapshot(),
          },
        });

        return {
          success: false,
          summary: incomplete
            ? 'Plan generation incomplete — agent could not produce a concrete plan within the budget.'
            : `Plan failed deterministic validation — ${validation.summary}`,
          filesCreated: artifactPaths,
          filesModified: [],
          filesRead: planningResult.filesRead,
          iterations: planningResult.iterations,
          tokensUsed: planningResult.tokensUsed,
          sessionId,
          plan,
        };
      }

      this.emit(config, {
        type: 'status:change',
        timestamp: new Date().toISOString(),
        sessionId,
        data: {
          status: 'waiting',
          message: 'Plan ready. Waiting for user approval before execution.',
          ...budgetSnapshot(),
        },
      });
      this.emit(config, {
        type: 'progress:update',
        timestamp: new Date().toISOString(),
        sessionId,
        data: {
          phase: 'plan',
          progress: 100,
          message: 'Plan mode complete',
          ...budgetSnapshot(),
        },
      });

      return {
        success: true,
        summary: `Plan draft ready (${phaseCount} phases, ${stepCount} steps). Awaiting approval.`,
        filesCreated: artifactPaths,
        filesModified: [],
        filesRead: planningResult.filesRead,
        iterations: planningResult.iterations,
        tokensUsed: planningResult.tokensUsed,
        sessionId,
        plan,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit(config, {
        type: 'status:change',
        timestamp: new Date().toISOString(),
        sessionId,
        data: {
          status: 'error',
          message,
        },
      });
      this.emit(config, {
        type: 'agent:end',
        timestamp: new Date().toISOString(),
        sessionId,
        startedAt,
        data: {
          success: false,
          summary: 'Plan mode failed',
          iterations: 1,
          tokensUsed: 0,
          durationMs: Date.now() - startMs,
          filesCreated: [],
          filesModified: [],
          stopReason: 'error',
        },
      });
      throw error;
    }
  }

  private async loadPlan(planPath: string): Promise<TaskPlan | null> {
    try {
      const raw = await fs.readFile(planPath, 'utf-8');
      return JSON.parse(raw) as TaskPlan;
    } catch {
      return null;
    }
  }

  private buildPlanPrompt(
    task: string,
    existingMarkdown?: string,
    maxIterations?: number,
    explorationBudget?: number,
    remainingTokens?: number,
    totalTokens?: number,
    enableDelegation = false,
  ): string {
    const budget = maxIterations || 10;
    const researchBudget = explorationBudget ?? Math.ceil(budget * (enableDelegation ? 0.55 : 0.35));
    const remainingText = typeof remainingTokens === 'number' ? remainingTokens.toLocaleString('en-US') : 'unknown';
    const totalText = typeof totalTokens === 'number' ? totalTokens.toLocaleString('en-US') : 'unknown';
    const revisionSection = existingMarkdown
      ? `\nExisting draft markdown (revise it based on the new request):\n\n${existingMarkdown}\n`
      : '';
    return `PLAN MODE ACTIVE.

Goal:
- Explore the repository with available read-only tools.
- Produce an executable implementation/refactor plan for the user request.
- DO NOT modify source files or run write/edit operations.

User request:
${task}
${revisionSection}

TOKEN BUDGET: ${remainingText}/${totalText} tokens remaining.

⚠️ CRITICAL: EXPLORE AND WRITE SIMULTANEOUSLY — never batch all research first.

## Mandatory workflow — repeat this cycle:

1. **Explore** — Read 3-5 files using fs_read, fs_list, grep_search, glob_search
2. **Update the plan file** — Call \`plan_write\` IMMEDIATELY after each discovery. Do NOT wait until the end.
   - First time: \`plan_write(content="# Plan\\n\\n## What I found so far\\n...")\`
   - Later: \`plan_write(content="<full updated plan with all sections>")\`
3. **Continue or finish** — If more exploration needed, go back to step 1. If plan covers all aspects, call \`plan_validate\` then \`report\`.

## Rules:
- NEVER make more than 5 tool calls without calling \`plan_write\`. The plan file is your working memory.
- Scale depth to the task: a vague feature request needs thorough exploration; a focused change needs 2-3 files.
- A partial plan with 3 concrete sections beats no plan with 30 files read.
- If you run out of budget, what's in plan_write IS your deliverable — so keep it updated.
- The plan file survives context compaction — your work is never lost.
- Hard limit: plan should be 30-50 lines. Delete prose if needed — keep file paths and concrete steps.

RESEARCH QUALITY GATE — before writing the plan, verify:
1. You found the actual entry point files for the feature (not just files that happen to mention keywords).
2. If your first search returned 0 results or irrelevant files — search again with different terms or explore the directory structure.
3. Do NOT reference a file in the plan unless you have read it and confirmed it is relevant.
4. If you are unsure where something lives — use fs_list on the top-level directories first to orient yourself.

${enableDelegation
  ? `DELEGATION WITH task_submit (ASYNC SUB-AGENTS):
You have access to async task tools for parallel sub-agent delegation:
- \`task_submit\` — fire off a sub-agent in the background, get a task ID immediately
- \`task_status\` — check progress of running tasks (without blocking)
- \`task_collect\` — wait for a specific task to complete and get its full result

WHEN TO DELEGATE — use task_submit if ANY of these are true:
- A directory has 3+ files that each need to be read fully (e.g. a whole package or module)
- You need to find all callers/usages across multiple packages
- The task involves a large file (500+ lines) AND other files also need reading
- You can split research into 2-3 independent questions that don't depend on each other
- The task mentions "ALL repositories" or "all packages" — delegate each repo/group to a sub-agent

HOW TO USE EFFECTIVELY:
1. Submit 2-3 parallel tasks, not more.
2. Continue your own work while sub-agents run in parallel.
3. Collect results with \`task_collect\` only when they are clearly relevant to the final plan.
4. Stop delegating once you have enough grounded evidence for the main implementation path.`
  : `SCOPED PLANNING:
- This task is narrow enough that async delegation is usually counterproductive.
- Prefer directly reading the 2-4 most relevant files, then draft the plan.
- Do NOT branch into broad workspace scans once the core implementation path is clear.
- If the first file guess is wrong, re-orient with \`fs_list\` or \`glob_search\`, then continue locally.`}

Output requirements:
- Final output must be a single markdown document.
- Include: title, Table of Contents, Task (A -> B), Steps/Phases, Risks, Verification, Approval.
- The ## Verification section MUST list concrete shell commands wrapped in backticks, e.g.:
  - \`pnpm --filter @kb-labs/agents/core build\`
  - \`pnpm --filter @kb-labs/agents/core test\`
  - \`pnpm --filter @kb-labs/agents/cli run build\`
- If revising existing plan, update the same plan and preserve useful parts.
- End with a short line that the plan is ready for user approval.

LANGUAGE: Write the plan body text in the SAME language as the user request above. Section headings (## Task, ## Steps, etc.) can stay in English, but all descriptions, explanations, and prose MUST match the user's language.

WRITING STYLE — the plan is for a HUMAN reader, not a machine:
- Write like you're explaining the plan to a colleague. A real person will read this top to bottom to verify you understood the task and didn't miss anything.
- For each phase/step, briefly explain WHY — not just "Edit file X at line Y" but what the change achieves and why it's needed.
- Show that you understood the current code: "Currently \`log()\` only calls console.log when verbose=true, but useLogger is already imported and unused — we'll wire it up".
- Use short prose paragraphs between steps to connect the narrative — the reader should feel the logical flow, not read a raw checklist.
- Keep code snippets short (3-5 lines max). The plan is a map, not the implementation itself. Reference line numbers instead of pasting large blocks.
- DO NOT pad with filler text. Every sentence should either explain context, justify a decision, or describe a concrete action.

QUALITY CRITERIA (your plan will be scored on these):
1. SPECIFICITY — reference ACTUAL file paths you discovered (e.g. \`src/planning/plan-generator.ts:1319\`)
2. ACTIONABILITY — every step must contain a file path OR a shell command, not just descriptions
3. VERIFICATION — include runnable commands (e.g. \`pnpm --filter @kb-labs/agents/core test\`)

Examples of GOOD vs BAD steps:
  BAD:  "Update the configuration file"
  GOOD: "Edit packages/agent-core/src/planning/plan-generator.ts:1319 — add specificity scoring to assessPlanQuality"

  BAD:  "Run tests"
  GOOD: "pnpm --filter @kb-labs/agents/core test — verify validator passes"

  BAD:  "Ensure the module exports are correct"
  GOOD: "Add \`export { PlanValidator }\` to packages/agent-core/src/planning/index.ts"

PLAN VALIDATION — MANDATORY BEFORE report():
After writing the plan markdown, you MUST validate it before submitting:

1. Call \`plan_validate(task="<original user task>", plan_markdown="<your plan>")\`
   - The tool will score your plan and return pass/fail with concrete feedback.
   - If PASSED: call \`report(answer=<plan>)\` immediately.
   - If FAILED: read the feedback, improve the specific sections it criticizes, then call \`plan_validate\` again.
   - After 3 consecutive FAILED validations: call \`ask_user(message=<plan + feedback summary>)\` to escalate.

2. NEVER call \`report()\` without a passing \`plan_validate\` first (unless you've exhausted all 3 attempts).

CRITICAL — TOOL USE REQUIRED:
You MUST call the \`report\` tool as your final action. Do NOT write the plan as plain text without a tool call.
- A plain-text response without calling \`report()\` is NOT a valid completion — it will fail the quality gate.
- Call \`report(answer=<your full markdown plan>, confidence=0.7)\` when done.
- Even if you think you are done, you MUST call \`report\` to submit the plan.`;
  }

  private createSubRunner(config: AgentConfig, toolRegistry: ToolRegistry, planProfile?: ReturnType<typeof createPlanRuntimeProfile>): IAgentRunner {
    return new AgentSDK()
      .registerRuntimeProfile(planProfile ?? createPlanRuntimeProfile())
      .register(createCoreToolPack(toolRegistry))
      .createRunner(config);
  }

  private buildFallbackPlan(
    sessionId: string,
    task: string,
    complexity: 'simple' | 'medium' | 'complex',
    summary: string,
    existingPlan: TaskPlan | null,
  ): TaskPlan {
    const markdown = [
      `# Plan: ${task}`,
      '',
      '> **WARNING:** Shared plan result mapper did not produce a structured plan; using fallback artifact.',
      '',
      '## Task',
      task,
      '',
      '## Notes',
      summary || 'No plan content was produced.',
    ].join('\n');

    return {
      id: existingPlan?.id || `plan-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      sessionId,
      task,
      mode: 'plan',
      phases: [],
      estimatedDuration: existingPlan?.estimatedDuration || 'Unknown',
      complexity,
      createdAt: existingPlan?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'failed',
      markdown,
    };
  }

  private buildBudgetSnapshot(sharedBudget: SharedTokenBudget, totalBudget: number): {
    budgetUsedTokens: number;
    budgetRemainingTokens: number;
    budgetTotalTokens: number;
  } {
    return {
      budgetUsedTokens: sharedBudget.used,
      budgetRemainingTokens: sharedBudget.remaining,
      budgetTotalTokens: totalBudget,
    };
  }

  private emit(config: AgentConfig, event: AgentEvent): void {
    if (!config.onEvent) {return;}
    config.onEvent({
      ...event,
      agentId: config.agentId,
      parentAgentId: config.parentAgentId,
    });
  }
}

function shouldEnablePlanDelegation(
  task: string,
  complexity: 'simple' | 'medium' | 'complex',
): boolean {
  if (complexity === 'complex') {
    return true;
  }
  return /\b(all repositories|all repos|all packages|entire workspace|whole workspace|across the repo|across repositories|monorepo-wide|workspace-wide)\b/i.test(task);
}

function buildPlanAllowedTools(enableDelegation: boolean): Set<string> {
  if (enableDelegation) {
    return new Set(PLAN_READ_ONLY_TOOL_NAMES);
  }
  return new Set([
    'fs_read',
    'fs_list',
    'glob_search',
    'grep_search',
    'find_definition',
    'code_stats',
    'memory_get',
    'memory_finding',
    'memory_blocker',
    'archive_recall',
    'ask_user',
    'report',
    'plan_validate',
    'plan_write',
  ]);
}
