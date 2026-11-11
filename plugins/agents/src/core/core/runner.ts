/**
 * SDKAgentRunner — clean agent implementation via AgentSDK.
 *
 * Composition:
 *   AgentSDK state  →  SDKAgentRunner  →  ObservabilityMiddleware (events + file tracking)
 *                                      →  BudgetMiddleware (token budget enforcement)
 *                                      →  ContextFilterMiddleware (sliding window + truncation)
 *                                      →  FactSheetMiddleware (structured working memory)
 *                                      →  ProgressMiddleware (stuck/loop detection)
 *                                      →  TodoSyncMiddleware (feature-flagged)
 *                                      →  SearchSignalMiddleware (feature-flagged)
 *                                      →  ReflectionMiddleware (feature-flagged)
 *                                      →  TaskClassifierMiddleware (feature-flagged)
 *                                      →  MiddlewarePipeline
 *                                      →  ToolManager (ToolPacks)
 *                                      →  ToolExecutor  (guards + processors)
 *                                      →  LoopContextImpl
 *                                      →  ExecutionLoop (LinearExecutionLoop)
 *                                      →  SubAgentOrchestrator (child agents)
 *
 * Tier escalation:
 *   - Runner iterates small → medium → large
 *   - If LoopResult.outcome === 'escalate', move to next tier
 *   - If LoopResult.outcome === 'complete', build TaskResult and return
 *
 * Mode routing:
 *   - mode === 'execute' → run the loop directly
 *   - any other mode    → delegate to getModeHandler() (plan/edit/debug)
 *     getModeHandler still needs a ToolRegistry for legacy mode handlers.
 *     We bridge via a thin ToolRegistry adapter wrapping ToolManager.
 *
 * Observability (from AgentConfig):
 *   - onEvent   → forwarded via ObservabilityMiddleware (agent:start/end, llm:*, tool:*, etc.)
 *   - memory    → context injected into system prompt via SystemPromptBuilder
 *   - conversationHistory → injected into messages before first user turn
 *   - filesRead/Modified/Created → tracked by ObservabilityMiddleware in run.meta
 *   - workingDir → WorkspaceDiscovery enriches system prompt with repo map
 */

import { randomUUID } from 'node:crypto';
import {
  useLLM,
  useAnalytics,
  useLogger,
  type LLMMessage,
  type LLMTool,
} from '@kb-labs/sdk';
import { AGENT_ANALYTICS_EVENTS } from '../../contracts/index.js';
import type { AgentConfig, AgentEvent, LLMTier, TaskResult, SpawnAgentRequest, SpawnAgentResult, SubAgentPreset } from '../../contracts/index.js';
import type { Turn } from '../../contracts/index.js';
import type { AgentSDK, IAgentRunner } from '../../sdk/index.js';
import { RuntimeEngine } from '../../runtime/index.js';
import { SessionArtifactStore } from '../../store/index.js';
import { LinearExecutionLoop } from '../execution/linear-execution-loop.js';
import { createDefaultRunEvaluator } from '../execution/default-run-evaluator.js';
import { MiddlewarePipeline } from '../middleware/pipeline.js';
import { ToolManager } from '../tools/tool-manager.js';
import { SystemPromptBuilder } from '../prompt/system-prompt-builder.js';

import { createRunContext } from './run-context.js';
import { ToolExecutor } from './tool-executor.js';
import { LoopContextImpl } from './loop-context.js';
import { ObservabilityMiddleware } from '../middleware/builtin/observability-middleware.js';
import { ContextFilterMiddleware } from '../middleware/builtin/context-filter-middleware.js';
import { BudgetMiddleware } from '../middleware/builtin/budget-middleware.js';
import { ProgressMiddleware } from '../middleware/builtin/progress-middleware.js';
import { FactSheetMiddleware } from '../middleware/builtin/factsheet-middleware.js';
import { AnalyticsMiddleware } from '../middleware/builtin/analytics-middleware.js';
import { ChangeTrackingMiddleware, getFileChangeSummaries } from '../middleware/builtin/change-tracking-middleware.js';
import { TaskMiddleware } from '../middleware/builtin/task-middleware.js';
import { discoverWorkspace } from '../execution/workspace-discovery.js';
import { ToolInputNormalizer } from '../tools/tool-input-normalizer.js';
import { createAsyncTaskToolPack } from '../tools/async-task-pack.js';
import { SessionManager } from '../planning/session-manager.js';
import { RunMetricsEmitter, getKpiBaselineKey } from '../analytics/index.js';
import type { RunKpiPayload } from '../analytics/index.js';
import { createSessionMemoryBridge } from './session-memory-bridge.js';

// ─────────────────────────────────────────────────────────────────────────────
// Tier escalation order
// ─────────────────────────────────────────────────────────────────────────────

const TIER_ORDER: LLMTier[] = ['small', 'medium', 'large'];

function nextTier(current: LLMTier): LLMTier | undefined {
  const idx = TIER_ORDER.indexOf(current);
  return idx >= 0 && idx < TIER_ORDER.length - 1 ? TIER_ORDER[idx + 1] : undefined;
}

type TierMetrics = {
  durationMs: number;
  toolCallsTotal: number;
  toolSuccessCount: number;
  toolErrorCount: number;
};

type TierResult = TaskResult & {
  _escalated?: boolean;
  _escalationReason?: string;
  _metrics: TierMetrics;
};

type QualityGateResult = {
  status: 'pass' | 'partial' | 'fail';
  score: number;
  reasons: string[];
};

// ─────────────────────────────────────────────────────────────────────────────
// SDKAgentRunner
// ─────────────────────────────────────────────────────────────────────────────

export class SDKAgentRunner implements IAgentRunner {
  readonly agentId: string;

  private readonly abortController: AbortController;
  private readonly injectedMessages: LLMMessage[] = [];
  private readonly runMetricsEmitter = new RunMetricsEmitter();
  /** Accumulated token count for the current execution. Promoted to class field for budget cap access by spawnChildAgent. */
  private totalTokens = 0;

  constructor(
    private readonly config: AgentConfig,
    private readonly sdk: AgentSDK,
  ) {
    this.agentId = config.agentId ?? randomUUID();
    this.abortController = new AbortController();

    // Honor parent abort signal
    if (config.abortSignal) {
      config.abortSignal.addEventListener('abort', () => this.abortController.abort());
    }
  }

  // ── IAgentRunner API ────────────────────────────────────────────────────────

  async execute(task: string): Promise<TaskResult> {
    const mode = this.config.mode?.mode ?? 'execute';

    // Non-execute modes delegate to ModeHandler — each handler owns its lifecycle.
    if (mode !== 'execute') {
      return this.runWithModeHandler(task);
    }

    // Execute mode: if there's an approved plan for this session, route through
    // ExecuteModeHandler so it can inject the plan and track lifecycle status.
    if (this.config.sessionId && this.config.workingDir) {
      const { SessionManager } = await import('../planning/session-manager.js');
      const { promises: fs } = await import('node:fs');
      try {
        const sessionManager = new SessionManager(this.config.workingDir);
        const planPath = sessionManager.getSessionPlanPath(this.config.sessionId);
        const raw = await fs.readFile(planPath, 'utf-8');
        const plan = JSON.parse(raw);
        if (plan.status === 'approved' || plan.status === 'draft') {
          return this.runWithModeHandler(task);
        }
      } catch {
        // No plan found — proceed with direct execution
      }
    }

    return this.runExecuteMode(task);
  }

  requestStop(): void {
    this.abortController.abort();
  }

  injectUserContext(message: string): void {
    this.injectedMessages.push({ role: 'user', content: message });
  }

  // ── Execute mode: tier escalation loop ─────────────────────────────────────

  private async runExecuteMode(task: string): Promise<TaskResult> {
    this.runMetricsEmitter.reset();
    const startTier: LLMTier = this.config.tier ?? 'medium';
    let currentTier = startTier;
    let tiersUsed = 0;
    let aggregateDurationMs = 0;
    let aggregateToolCalls = 0;
    let aggregateToolSuccesses = 0;
    let aggregateToolErrors = 0;
    let aggregateTokens = 0;
    let aggregateIterations = 0;
    const filesRead = new Set<string>();
    const filesModified = new Set<string>();
    const filesCreated = new Set<string>();

    while (true) {
      const result = await this.executeWithTier(task, currentTier);
      tiersUsed += 1;
      aggregateDurationMs += result._metrics.durationMs;
      aggregateToolCalls += result._metrics.toolCallsTotal;
      aggregateToolSuccesses += result._metrics.toolSuccessCount;
      aggregateToolErrors += result._metrics.toolErrorCount;
      aggregateTokens += result.tokensUsed;
      aggregateIterations += result.iterations;
      for (const path of result.filesRead) {filesRead.add(path);}
      for (const path of result.filesModified) {filesModified.add(path);}
      for (const path of result.filesCreated) {filesCreated.add(path);}

      if (result._escalated) {
        const next = nextTier(currentTier);
        if (next) {
          const logger = useLogger();
          logger.info(`[SDKAgentRunner] Escalating: ${currentTier} → ${next}`);
          await this.recordTierEscalation(
            currentTier,
            next,
            result._escalationReason ?? result.summary,
            result.iterations,
            task,
          );
          this.config.onEvent?.({
            type: 'status:change',
            timestamp: new Date().toISOString(),
            agentId: this.agentId,
            data: { status: 'escalating', message: `Tier escalation: ${currentTier} → ${next}` },
          } as unknown as AgentEvent);
          currentTier = next;
          continue;
        }
        // Already at highest tier — return whatever we got
        const { _escalated: _, _escalationReason: __, _metrics: ___, ...taskResult } = result;
        const finalResult: TaskResult = {
          ...taskResult,
          iterations: aggregateIterations,
          tokensUsed: aggregateTokens,
          filesRead: [...filesRead],
          filesModified: [...filesModified],
          filesCreated: [...filesCreated],
        };
        await this.emitRunKpis(task, startTier, currentTier, tiersUsed, finalResult, {
          durationMs: aggregateDurationMs,
          toolCallsTotal: aggregateToolCalls,
          toolSuccessCount: aggregateToolSuccesses,
          toolErrorCount: aggregateToolErrors,
        });
        return finalResult;
      }

      const { _escalated: _, _escalationReason: __, _metrics: ___, ...taskResult } = result;
      const finalResult: TaskResult = {
        ...taskResult,
        iterations: aggregateIterations,
        tokensUsed: aggregateTokens,
        filesRead: [...filesRead],
        filesModified: [...filesModified],
        filesCreated: [...filesCreated],
      };
      await this.emitRunKpis(task, startTier, currentTier, tiersUsed, finalResult, {
        durationMs: aggregateDurationMs,
        toolCallsTotal: aggregateToolCalls,
        toolSuccessCount: aggregateToolSuccesses,
        toolErrorCount: aggregateToolErrors,
      });
      return finalResult;
    }
  }

  // ── Single-tier execution ───────────────────────────────────────────────────

  private async executeWithTier(
    task: string,
    tier: LLMTier,
  ): Promise<TierResult> {
    const logger = useLogger();
    const tierStartedAt = Date.now();
    let toolSuccessCount = 0;
    let toolErrorCount = 0;
    let toolCallsTotal = 0;
    let runDurationMs = 0;
    const runtimeStore = this.config.sessionId
      ? new SessionArtifactStore(this.config.workingDir)
      : null;
    const runtimeEngine = this.config.sessionId && runtimeStore
      ? new RuntimeEngine(this.sdk, runtimeStore)
      : null;

    // ── 1. LLM ───────────────────────────────────────────────────────────────
    const llm = useLLM({ tier });
    if (!llm?.chatWithTools) {
      return this.withMetrics(
        this.failResult(`LLM tier "${tier}" not available or doesn't support tool calling`, 0),
        { durationMs: Date.now() - tierStartedAt, toolCallsTotal: 0, toolSuccessCount: 0, toolErrorCount: 0 },
      );
    }

    // ── 2. ToolManager ───────────────────────────────────────────────────────
    const toolManager = new ToolManager({
      onAudit: (toolName, packId, input) => {
        logger?.debug?.(`[audit] pack=${packId} tool=${toolName} input=${JSON.stringify(input)}`);
      },
    });

    for (const pack of this.sdk.packs) {
      toolManager.register(pack);
    }

    // Register async task tools (only for parent agents that can spawn sub-agents)
    const taskMw = new TaskMiddleware({ maxConcurrent: 5 });
    if (!this.config.parentAgentId) {
      taskMw.setSpawnFn((req) => this.spawnChildAgent(req));
      toolManager.register(createAsyncTaskToolPack(taskMw));
    }

    await toolManager.initializeAll();

    // Apply tool allowlist for sub-agents (preset-based filtering)
    if (this.config.allowedTools && this.config.allowedTools.length > 0) {
      toolManager.applyAllowlist(this.config.allowedTools);
    }

    // ── 3. ToolExecutor (normalizers + guards + processors) ───────────────────
    const coreNormalizer = new ToolInputNormalizer({
      workingDir: this.config.workingDir,
    });
    const toolExecutor = new ToolExecutor(
      toolManager,
      this.sdk.guards,
      this.sdk.outputProcessors,
      [coreNormalizer, ...this.sdk.inputNormalizers],
    );

    // ── 4. Core middlewares ───────────────────────────────────────────────────

    // Reset token counter for this tier attempt (class field for budget cap access)
    this.totalTokens = 0;

    // ObservabilityMiddleware — events + file tracking (order=5)
    const runtimeAwareOnEvent: AgentConfig['onEvent'] = (event) => {
      if (runtimeEngine && this.config.sessionId) {
        void runtimeEngine.recordEvent({ ...event, sessionId: event.sessionId || this.config.sessionId });
      }
      void this.config.onEvent?.(event);
    };

    const observabilityMw = new ObservabilityMiddleware(
      this.agentId,
      this.config.parentAgentId,
      this.config.sessionId,
      runtimeAwareOnEvent,
    );

    // BudgetMiddleware — token enforcement (order=10)
    // Default: 1M tokens per run. Token budget is the primary execution control;
    // maxIterations is only a safety net.
    const budgetCfg = this.config.tokenBudget;
    const defaultMaxTokens = 1_000_000;
    const budgetMw = new BudgetMiddleware(
      {
        active: true,
        maxTokens: budgetCfg?.maxTokens ?? defaultMaxTokens,
        softLimitRatio: budgetCfg?.softLimitRatio ?? 0.8,
        hardLimitRatio: budgetCfg?.hardLimitRatio ?? 1.0,
        hardStop: budgetCfg?.hardStop ?? false,
        forceSynthesisOnHardLimit: budgetCfg?.forceSynthesisOnHardLimit ?? true,
      },
      () => this.totalTokens,
    );

    // ContextFilterMiddleware — sliding window + output truncation + compaction (order=15)
    const contextFilterMw = new ContextFilterMiddleware({
      maxOutputLength: 8000,
      slidingWindowSize: 10,
      enableCompaction: true,
    });

    // FactSheetMiddleware — structured working memory (order=20)
    const factSheetMw = new FactSheetMiddleware({
      persistDir: this.config.sessionId
        ? `${this.config.workingDir}/.kb/memory/sessions/${this.config.sessionId}`
        : undefined,
      summarizationInterval: 5,
    });

    // ChangeTrackingMiddleware — file snapshot capture + rollback support (order=8)
    const changeTrackingMw = new ChangeTrackingMiddleware({
      agentId: this.agentId,
      sessionId: this.config.sessionId,
      workingDir: this.config.workingDir,
    });

    // ProgressMiddleware — stuck/loop detection (order=50)
    const progressMw = new ProgressMiddleware(4, {
      onStuck: (iteration, iters) => {
        logger?.warn?.(`[progress] stuck at iteration ${iteration} (${iters} iters without progress)`);
      },
      onLoop: (iteration, calls) => {
        logger?.warn?.(`[progress] loop detected at iteration ${iteration}: ${calls.join(', ')}`);
      },
    });
    const analytics = this.getAnalytics();
    const analyticsMw = new AnalyticsMiddleware({
      onToolOutcome: (outcome) => {
        toolCallsTotal += 1;
        if (outcome.success) {
          toolSuccessCount += 1;
        } else {
          toolErrorCount += 1;
        }
        this.runMetricsEmitter.trackToolOutcome(
          {
            toolName: outcome.toolName,
            success: outcome.success,
            durationMs: outcome.durationMs ?? 0,
            errorCode: outcome.errorCode,
          },
          {
            analytics,
            toolCalledEvent: AGENT_ANALYTICS_EVENTS.TOOL_CALLED,
            log: (msg: string) => logger?.warn?.(msg),
          },
        );
      },
      onRunComplete: (metrics) => {
        runDurationMs = metrics.durationMs;
      },
    });

    // ── 5. MiddlewarePipeline ────────────────────────────────────────────────
    // sdk.middlewares = optional extras registered by the caller (TodoSync, Reflection, etc.)
    const featureFlags = {
      twoTierMemory: true, todoSync: true, searchSignal: true,
      reflection: true, taskClassifier: true, smartSummarizer: true,
      tierEscalation: true,
    };
    const pipeline = new MiddlewarePipeline(
      [observabilityMw, changeTrackingMw, budgetMw, contextFilterMw, factSheetMw, taskMw, progressMw, analyticsMw, ...this.sdk.middlewares],
      {
        featureFlags,
        onError: (middlewareName, hookName, error) => {
          const msg = error instanceof Error ? error.message : String(error);
          logger?.warn?.(`[middleware] ${middlewareName}.${hookName} failed (fail-open): ${msg}`);
        },
      },
    );

    // ── 8. RunContext ──────────────────────────────────────────────────────
    const requestId = randomUUID();
    const tools = this.buildLLMTools(toolManager);

    const { run, messages } = createRunContext({
      config: this.config,
      tier,
      tools,
      abortController: this.abortController,
      requestId,
    });
    (run as { task: string }).task = task;

    // ── 10. System prompt (memory + workspace discovery) ──────────────────────
    const workspaceDiscovery = await discoverWorkspace(this.config.workingDir).catch(() => null);
    const sessionManager = this.config.sessionId
      ? new SessionManager(this.config.workingDir)
      : null;
    if (runtimeEngine && this.config.sessionId) {
      await runtimeEngine.loadOrCreateKernel({
        sessionId: this.config.sessionId,
        workingDir: this.config.workingDir,
        mode: this.config.mode?.mode,
        task,
      });
    }
    const directAnswer = runtimeEngine
      ? await runtimeEngine.tryResolveDirectAnswer([])
      : null;
    if (runtimeEngine && directAnswer && this.config.sessionId) {
      await runtimeEngine.completeRun({
        sessionId: this.config.sessionId,
        mode: this.config.mode?.mode,
        summary: directAnswer.answer,
        filesRead: directAnswer.filesRead,
      });
      const directResult: TaskResult = {
        success: true,
        summary: directAnswer.answer,
        filesCreated: [],
        filesModified: [],
        filesRead: directAnswer.filesRead,
        iterations: 1,
        tokensUsed: 0,
        sessionId: this.config.sessionId,
      };
      return this.withMetrics(directResult, {
        durationMs: Date.now() - tierStartedAt,
        toolCallsTotal: 0,
        toolSuccessCount: 0,
        toolErrorCount: 0,
      });
    }
    const continuityEnabled = !!this.config.sessionId;
    const traceArtifactsContext = continuityEnabled && this.config.sessionId && sessionManager
      ? await sessionManager.getTraceArtifactsContext(this.config.sessionId).catch(() => '')
      : '';
    const sessionFactsHint = this.config.sessionId && sessionManager && this.shouldInjectSessionFacts(task)
      ? await this.getSessionFactsHint(sessionManager, this.config.sessionId)
      : '';
    const runtimePromptContext = runtimeEngine
      ? await runtimeEngine.projectPrompt([])
      : '';

    const promptBuilder = new SystemPromptBuilder();
    const systemPrompt = await promptBuilder.build({
      workingDir: this.config.workingDir,
      responseMode: 'auto',
      isSubAgent: !!this.config.parentAgentId,
      sessionId: this.config.sessionId,
      currentTask: task,
      workspaceDiscovery: workspaceDiscovery ?? undefined,
      archiveSummaryHint: [runtimePromptContext, sessionFactsHint, traceArtifactsContext]
        .filter(Boolean)
        .join('\n\n') || undefined,
    });

    // ── 11. Initial messages: system + task ──────────────────────────────────
    messages.push({ role: 'system', content: systemPrompt });

    const historyMessages = continuityEnabled ? await this.loadConversationMessages(task) : [];
    messages.push(...historyMessages);

    messages.push({ role: 'user', content: task });

    // Inject any queued user context (from injectUserContext() calls)
    for (const msg of this.injectedMessages) {
      messages.push(msg);
    }

    // ── 12. Loop ──────────────────────────────────────────────────────────────
    const loop = this.sdk.loop ?? new LinearExecutionLoop();

    const loopCtx = new LoopContextImpl(
      run,
      messages,
      llm,
      pipeline,
      toolExecutor,
      (delta) => { this.totalTokens += delta; },
      async (activeRun, snapshot) => {
        const runtimeProfileEvaluators = runtimeEngine?.getActiveProfile()?.runEvaluators ?? [];
        const evaluators = [
          ...runtimeProfileEvaluators,
          ...this.sdk.runEvaluators,
          createDefaultRunEvaluator(),
        ];
        let best: Awaited<ReturnType<typeof evaluators[number]['evaluate']>> = null;
        for (const evaluator of evaluators) {
          const result = await evaluator.evaluate({ run: activeRun, snapshot });
          if (!result) {
            continue;
          }
          if (!best || result.readinessScore >= best.readinessScore) {
            best = result;
          }
        }
        return best;
      },
    );

    // Enrich observability with budget + workspace for agent:start trace event
    observabilityMw.startMeta = {
      budget: {
        maxTokens: budgetMw['policy'].maxTokens,
        softLimitRatio: budgetMw['policy'].softLimitRatio,
        hardLimitRatio: budgetMw['policy'].hardLimitRatio,
      },
      workspaceTopology: workspaceDiscovery?.repos.map(r => {
        const rel = r.path.replace(this.config.workingDir + '/', '') || '.';
        return `${rel} (${r.reasons.join(', ')})`;
      }),
      workingDir: this.config.workingDir,
    };

    await pipeline.onStart(run);

    const loopResult = await loop.run(loopCtx);

    // ── 11. Handle escalation ─────────────────────────────────────────────────
    if (loopResult.outcome === 'escalate') {
      await pipeline.onStop(run, 'escalate');
      return this.withMetrics({
        ...this.failResult(`Escalating to next tier: ${loopResult.reason}`, run.iteration),
        _escalated: true,
        _escalationReason: loopResult.reason,
      }, {
        durationMs: runDurationMs || (Date.now() - tierStartedAt),
        toolCallsTotal,
        toolSuccessCount,
        toolErrorCount,
      });
    }

    // ── 12. Build TaskResult ──────────────────────────────────────────────────
    // Handle handoff (treat as a failed run — handoff routing not implemented here)
    if (loopResult.outcome === 'handoff') {
      await pipeline.onStop(run, 'handoff');
      await toolManager.disposeAll();
      return this.withMetrics(this.failResult(
        `Agent requested handoff to "${loopResult.toAgent}" (not supported in SDKAgentRunner)`,
        run.iteration,
      ), {
        durationMs: runDurationMs || (Date.now() - tierStartedAt),
        toolCallsTotal,
        toolSuccessCount,
        toolErrorCount,
      });
    }

    const output = loopResult.result;

    // Store final answer in meta so ObservabilityMiddleware can include it in agent:end
    if (output.answer) {
      run.meta.set('agent', 'finalAnswer', output.answer);
    }

    await pipeline.onStop(run, output.reasonCode);
    if (output.success) {
      await pipeline.onComplete(run);
    }

    await toolManager.disposeAll();

    // Read file tracking from run.meta (populated by ObservabilityMiddleware)
    const filesRead = run.meta.get<string[]>('files', 'read') ?? [];
    const filesModified = run.meta.get<string[]>('files', 'modified') ?? [];
    const filesCreated = run.meta.get<string[]>('files', 'created') ?? [];

    // Read file change summaries from run.meta (populated by ChangeTrackingMiddleware)
    const fileChanges = getFileChangeSummaries(run);

    const completionMetadata = { ...(output.metadata ?? {}) } as Record<string, unknown>;
    const runtimeProfileResultMappers = runtimeEngine?.getActiveProfile()?.resultMappers ?? [];

    let taskResult: TaskResult = {
      success: output.success,
      summary: output.answer,
      filesCreated,
      filesModified,
      filesRead,
      iterations: run.iteration,
      tokensUsed: this.totalTokens,
      sessionId: this.config.sessionId,
      fileChanges: fileChanges.length > 0 ? fileChanges : undefined,
      metrics: {
        stopReasonCode: output.reasonCode,
        repeatNoEvidenceCount: run.meta.get<number>('loop', 'repeatNoEvidenceCount') ?? 0,
        repeatNoEvidenceRate:
          run.iteration > 0
            ? (run.meta.get<number>('loop', 'repeatNoEvidenceCount') ?? 0) / run.iteration
            : 0,
        convergenceRecommendation: run.meta.get<string>('evaluation', 'lastRecommendation') ?? 'continue',
        convergenceReadinessScore: run.meta.get<number>('evaluation', 'lastReadinessScore') ?? 0,
        convergenceEvidenceGain: run.meta.get<number>('evaluation', 'lastEvidenceGain') ?? 0,
      },
    };

    for (const mapper of runtimeProfileResultMappers) {
      const mapped = await mapper.map({
        state: runtimeEngine?.getKernel() ?? null,
        answer: taskResult.summary,
        mode: this.config.mode?.mode === 'execute'
          ? 'autonomous'
          : 'assistant',
        task,
        sessionId: this.config.sessionId,
        workingDir: this.config.workingDir,
        metadata: completionMetadata,
      });
      if (!mapped) {
        continue;
      }
      if (mapped.summary) {
        taskResult.summary = mapped.summary;
      }
      if (mapped.taskResult) {
        taskResult = {
          ...taskResult,
          ...mapped.taskResult,
          metrics: {
            ...(taskResult.metrics ?? {}),
            ...((mapped.taskResult.metrics as Record<string, unknown> | undefined) ?? {}),
          },
        };
      }
      if (mapped.runtimeMetadata) {
        Object.assign(completionMetadata, mapped.runtimeMetadata);
      }
    }

    if (runtimeEngine && this.config.sessionId) {
      const completion = await runtimeEngine.completeRun({
        sessionId: this.config.sessionId,
        runId: requestId,
        mode: this.config.mode?.mode,
        summary: taskResult.summary,
        filesRead,
        filesModified,
        filesCreated,
        metadata: Object.keys(completionMetadata).length > 0 ? completionMetadata : undefined,
      });
      taskResult = {
        ...taskResult,
        success: taskResult.success && !completion.blockedByPolicy,
        summary: completion.blockedByPolicy
          ? `Final output failed runtime profile validation: ${completion.validationResults.find((result) => result.verdict === 'block')?.rationale ?? 'blocked by completion policy'}`
          : taskResult.summary,
        metrics: {
          ...(taskResult.metrics ?? {}),
          runtimeCompletion: completion,
        },
      };
    }

    return this.withMetrics(taskResult, {
      durationMs: runDurationMs || (Date.now() - tierStartedAt),
      toolCallsTotal,
      toolSuccessCount,
      toolErrorCount,
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private extractTurnText(turn: Turn, role: 'user' | 'assistant'): string | undefined {
    const parts = turn.steps
      .filter((step): step is Extract<Turn['steps'][number], { type: 'text' }> =>
        step.type === 'text' && step.role === role
      )
      .map((step) => step.content?.trim())
      .filter((value): value is string => Boolean(value));
    if (parts.length === 0) {
      return undefined;
    }
    return parts.join('\n\n');
  }

  private async loadConversationMessages(currentTask: string): Promise<LLMMessage[]> {
    if (!this.config.sessionId || this.config.parentAgentId) {
      return [];
    }
    try {
      const manager = new SessionManager(this.config.workingDir);
      const turns = await manager.getTurns(this.config.sessionId);
      const sorted = [...turns].sort((a, b) => a.sequence - b.sequence).slice(-16);
      const messages: LLMMessage[] = [];

      for (const turn of sorted) {
        if (turn.type === 'user') {
          const text = this.extractTurnText(turn, 'user');
          if (text) {
            messages.push({ role: 'user', content: text });
          }
          continue;
        }
        if (turn.type === 'assistant') {
          const text = this.extractTurnText(turn, 'assistant');
          if (text) {
            messages.push({ role: 'assistant', content: text });
          }
        }
      }

      // If CLI already pre-created a user turn for current task, avoid duplicate.
      while (messages.length > 0) {
        const tail = messages[messages.length - 1];
        if (tail?.role === 'user' && tail.content.trim() === currentTask.trim()) {
          messages.pop();
          continue;
        }
        break;
      }

      return messages;
    } catch {
      return [];
    }
  }

  private buildLLMTools(toolManager: ToolManager): LLMTool[] {
    return toolManager.getDefinitions().map((def) => ({
      name: def.function.name,
      description: def.function.description,
      inputSchema: def.function.parameters,
    }));
  }

  /**
   * Spawn a child agent with budget cap, tool filtering, and structured results.
   *
   * Budget cap: childBudget = parentRemainingBudget × request.budgetFraction.
   * If parent has no budget (maxTokens=0), child also runs without budget.
   *
   * Tool filtering: request.allowedTools → childConfig.allowedTools → child's
   * ToolContext.allowedTools, which gates tool registration in createToolRegistry().
   */
  private async spawnChildAgent(request: SpawnAgentRequest): Promise<SpawnAgentResult> {
    const startedAt = Date.now();

    // Budget cap: compute child token budget from parent's remaining budget
    const parentBudget = this.config.tokenBudget;
    const parentMaxTokens = parentBudget?.maxTokens ?? 0;
    const parentRemaining = parentMaxTokens > 0 ? Math.max(0, parentMaxTokens - this.totalTokens) : 0;
    const budgetFraction = request.budgetFraction ?? 0.5;
    const childMaxTokens = parentMaxTokens > 0 ? Math.floor(parentRemaining * budgetFraction) : 0;

    const childConfig: AgentConfig = {
      ...this.config,
      agentId: randomUUID(),
      parentAgentId: this.agentId,
      maxIterations: request.maxIterations ?? 100,
      workingDir: request.workingDir ?? this.config.workingDir,
      abortSignal: this.abortController.signal,
      allowedTools: request.allowedTools,
      // Child budget: capped at fraction of parent's remaining budget
      tokenBudget: childMaxTokens > 0
        ? {
          enabled: true,
          maxTokens: childMaxTokens,
          softLimitRatio: parentBudget?.softLimitRatio ?? 0.7,
          hardLimitRatio: parentBudget?.hardLimitRatio ?? 1.0,
          hardStop: parentBudget?.hardStop ?? false,
          forceSynthesisOnHardLimit: parentBudget?.forceSynthesisOnHardLimit ?? true,
        }
        : this.config.tokenBudget,
    };

    const childSDK = this.sdk.extend();
    const childRunner = new SDKAgentRunner(childConfig, childSDK);
    const preset: SubAgentPreset = request.preset ?? 'research';

    try {
      const result = await childRunner.execute(request.task);
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
        preset,
      };
    } catch (error) {
      return {
        success: false,
        summary: '',
        filesRead: [],
        filesModified: [],
        filesCreated: [],
        iterations: 0,
        tokensUsed: 0,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
        preset,
      };
    }
  }

  private async runWithModeHandler(task: string): Promise<TaskResult> {
    const { getModeHandler } = await import('../modes/mode-handler.js');
    const { createToolRegistry } = await import('../../tools/index.js');

    const toolRegistry = createToolRegistry({
      workingDir: this.config.workingDir,
      sessionId: this.config.sessionId,
      verbose: false,
      sessionMemory: createSessionMemoryBridge(this.config.workingDir, this.config.sessionId),
    });

    const handler = await getModeHandler(this.config.mode);
    return handler.execute(task, this.config, toolRegistry);
  }

  private withMetrics(
    result: TaskResult & { _escalated?: boolean; _escalationReason?: string },
    metrics: TierMetrics,
  ): TierResult {
    return {
      ...result,
      _escalated: result._escalated,
      _escalationReason: result._escalationReason,
      _metrics: metrics,
    };
  }

  private makeEmitContext() {
    const analytics = this.getAnalytics();
    const sessionId = this.config.sessionId;
    const logger = useLogger();

    if (!sessionId) {
      return {
        analytics,
        baselineKey: getKpiBaselineKey('', this.config.workingDir || ''),
        log: (msg: string) => logger?.warn?.(msg),
      };
    }

    const sessionManager = new SessionManager(this.config.workingDir);
    return {
      analytics,
      sessionId,
      persister: {
        getKpiBaseline: async (sid: string) => sessionManager.getKpiBaseline(sid),
        updateKpiBaseline: async (
          sid: string,
          updater: () => {
            version: number;
            updatedAt: string;
            driftRateEma: number;
            evidenceDensityEma: number;
            toolErrorRateEma: number;
            samples: number;
            tokenHistory: number[];
            iterationUtilizationHistory: number[];
            qualityScoreHistory: number[];
          },
        ) => sessionManager.updateKpiBaseline(sid, () => updater()),
      },
      baselineKey: getKpiBaselineKey('', this.config.workingDir || ''),
      log: (msg: string) => logger?.warn?.(msg),
    };
  }

  private async recordTierEscalation(
    from: LLMTier,
    to: LLMTier,
    reason: string,
    iteration: number,
    task: string,
  ): Promise<void> {
    await this.runMetricsEmitter.recordTierEscalation(from, to, reason, iteration, {
      analytics: this.getAnalytics(),
      sessionId: this.config.sessionId,
      agentId: this.agentId,
      task,
      tierEscalatedEvent: AGENT_ANALYTICS_EVENTS.TIER_ESCALATED,
      log: (msg: string) => useLogger()?.warn?.(msg),
    });
  }

  private async emitRunKpis(
    task: string,
    startTier: LLMTier,
    finalTier: LLMTier,
    tiersUsed: number,
    result: TaskResult,
    aggregate: TierMetrics,
  ): Promise<void> {
    const iterationBudget = Math.max(1, (this.config.maxIterations || 0) * Math.max(1, tiersUsed));
    const tokenBudget = this.config.tokenBudget?.enabled ? this.config.tokenBudget.maxTokens : undefined;
    const driftDomains = this.deriveDriftDomains(result);
    const qualityGate = this.evaluateQualityGate(result, aggregate, driftDomains.length);

    const payload: RunKpiPayload = {
      sessionId: this.config.sessionId,
      agentId: this.agentId,
      task,
      success: result.success,
      error: result.error,
      summaryPreview: (result.summary || '').slice(0, 300),
      iterationsUsed: result.iterations,
      iterationBudget,
      tokenBudget,
      tokenUtilization: tokenBudget && tokenBudget > 0 ? result.tokensUsed / tokenBudget : undefined,
      startTier,
      finalTier,
      durationMs: aggregate.durationMs,
      tokensUsed: result.tokensUsed,
      toolCallsTotal: aggregate.toolCallsTotal,
      toolSuccessCount: aggregate.toolSuccessCount,
      toolErrorCount: aggregate.toolErrorCount,
      todoToolCalls: 0,
      filesReadCount: result.filesRead.length,
      filesModifiedCount: result.filesModified.length,
      filesCreatedCount: result.filesCreated.length,
      driftDomainCount: driftDomains.length,
      driftDomains,
      executionPhase: result.success ? 'complete' : 'failed',
      phaseDurationsMs: {},
      phaseTransitionCount: 0,
      phaseTransitions: [],
      ledger: { failedSteps: aggregate.toolErrorCount, pendingSteps: 0 },
      qualityGate,
      repeatNoEvidenceRate: typeof result.metrics?.['repeatNoEvidenceRate'] === 'number'
        ? Number(result.metrics['repeatNoEvidenceRate'])
        : undefined,
    };

    await this.runMetricsEmitter.emitRunKpis(payload, this.makeEmitContext());
  }

  private getAnalytics() {
    return this.config.analytics ?? useAnalytics() ?? null;
  }

  private failResult(message: string, iterations: number): TaskResult {
    return {
      success: false,
      summary: message,
      filesCreated: [],
      filesModified: [],
      filesRead: [],
      iterations,
      tokensUsed: 0,
      error: message,
      sessionId: this.config.sessionId,
    };
  }

  private async getSessionFactsHint(sessionManager: SessionManager, sessionId: string): Promise<string> {
    const turns = await sessionManager.getTurns(sessionId).catch(() => []);
    if (turns.length === 0) {
      return '';
    }
    const completedUserTurns = turns.filter((t) => t.type === 'user' && t.status === 'completed').length;
    const completedAssistantTurns = turns.filter((t) => t.type === 'assistant' && t.status === 'completed').length;
    const lines = [
      '# Session Facts',
      `Completed user turns in this session: ${completedUserTurns}`,
      `Completed assistant turns in this session: ${completedAssistantTurns}`,
    ];
    lines.push('For meta-session questions (previous message/count in this session), prefer these facts before file search.');
    return lines.join('\n');
  }

  private shouldInjectSessionFacts(task: string): boolean {
    const lower = task.toLowerCase();
    const hints = [
      'предыдущ',
      'сообщен',
      'в этом бенче',
      'в этой сессии',
      'previous',
      'message',
      'session',
      'in this bench',
      'in this session',
    ];
    return hints.some((h) => lower.includes(h));
  }

  private deriveDriftDomains(result: TaskResult): string[] {
    const domains = new Set<string>();
    const files = [...result.filesRead, ...result.filesModified, ...result.filesCreated];
    for (const file of files) {
      const normalized = file.replace(/\\/g, '/');
      const rel = normalized.startsWith(this.config.workingDir.replace(/\\/g, '/'))
        ? normalized.slice(this.config.workingDir.length).replace(/^\/+/, '')
        : normalized;
      const first = rel.split('/').find((part) => part.length > 0);
      domains.add(first ?? '.');
    }
    return [...domains];
  }

  private evaluateQualityGate(
    result: TaskResult,
    aggregate: TierMetrics,
    driftDomainCount: number,
  ): QualityGateResult {
    const reasons: string[] = [];
    const evidenceCount = result.filesRead.length + result.filesModified.length + result.filesCreated.length;
    const evidenceDensity = result.iterations > 0 ? evidenceCount / result.iterations : evidenceCount;
    const toolReliability = aggregate.toolCallsTotal > 0
      ? aggregate.toolSuccessCount / aggregate.toolCallsTotal
      : (result.success ? 1 : 0);

    const completionScore = result.success ? 1 : 0.35;
    const evidenceScore = Math.min(1, evidenceDensity / 1.5);
    const reliabilityScore = Math.min(1, Math.max(0, toolReliability));
    const repeatNoEvidenceRate = typeof result.metrics?.['repeatNoEvidenceRate'] === 'number'
      ? Number(result.metrics['repeatNoEvidenceRate'])
      : 0;
    const forgetfulnessPenalty = repeatNoEvidenceRate > 0.2
      ? Math.min(0.15, repeatNoEvidenceRate * 0.3)
      : 0;
    const driftPenalty = driftDomainCount > 2 ? 0.08 : 0;

    let score =
      (completionScore * 0.45) +
      (evidenceScore * 0.25) +
      (reliabilityScore * 0.30) -
      driftPenalty -
      forgetfulnessPenalty;
    score = Math.max(0, Math.min(1, score));

    if (!result.success) {
      reasons.push('task_not_completed');
    }
    if (aggregate.toolErrorCount > 0) {
      reasons.push('tool_errors_present');
    }
    if (evidenceCount === 0) {
      reasons.push('no_evidence_collected');
    }
    if (driftDomainCount > 2) {
      reasons.push('scope_drift_detected');
    }
    if (repeatNoEvidenceRate > 0.2) {
      reasons.push('repeated_without_new_evidence');
    }

    const stopReason = typeof result.metrics?.['stopReasonCode'] === 'string'
      ? String(result.metrics?.['stopReasonCode'])
      : '';
    if ((stopReason === 'max_iterations' || stopReason === 'loop_detected') && evidenceCount > 0) {
      reasons.push('partial_due_to_iteration_limit');
      score = Math.max(score, 0.35);
    }

    if (score >= 0.55 && result.success) {
      return { status: 'pass', score, reasons };
    }
    if (score >= 0.3) {
      return { status: 'partial', score, reasons };
    }
    return { status: 'fail', score, reasons };
  }
}
