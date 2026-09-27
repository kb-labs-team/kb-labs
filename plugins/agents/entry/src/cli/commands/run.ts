/**
 * agent:run command - unified agent interface
 *
 * Uses event-driven UI rendering instead of simple loaders.
 */

import { canUseLLMForMessages, defineCommand, useAnalytics, useCache, useConfig, type CommandResult, type PluginContextV3 } from '@kb-labs/sdk';
import {
  SessionManager,
  PlanDocumentService,
  SpecModeHandler,
  bootstrapAgentSDK,
  createSessionMemoryBridge,
  createCoreToolPack,
} from '@kb-labs/agent-core';
import { AgentSDK } from '@kb-labs/agent-sdk';
import { AgentAttachmentError, createDefaultResponseRequirementsSelector, prepareAgentAttachments } from '@kb-labs/agent-runtime';
import { IncrementalTraceWriter } from '@kb-labs/agent-tracing';
import { createToolRegistry } from '@kb-labs/agent-tools';
import type { AgentConfig, ModeConfig, AgentMode, AgentEvent, AgentsPluginConfig, KernelState, DetailedTraceEntry } from '@kb-labs/agent-contracts';
import type { TaskPlan } from '@kb-labs/agent-contracts';
import type { AgentAttachmentUpload } from '@kb-labs/agent-contracts';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createEventRenderer, createMinimalRenderer, createDetailedRenderer, createDebugRenderer } from '../ui/index.js';

// Register SDKAgentRunner as the RunnerFactory (idempotent — runs once per process)
bootstrapAgentSDK();

type RunInput = {
  task: string;
  workingDir?: string;
  maxIterations?: number;
  temperature?: number;
  verbose?: boolean;
  quiet?: boolean;
  detailed?: boolean;
  sessionId?: string;
  tier?: 'small' | 'medium' | 'large';
  escalate?: boolean;
  mode?: AgentMode;
  complexity?: 'simple' | 'medium' | 'complex';
  files?: string[];
  attachments?: string[];
  trace?: string;
  approve?: boolean;
  execute?: boolean;
  spec?: boolean;
  'dry-run'?: boolean;
  debug?: boolean;
  /** Abort execution after this many seconds (0 or undefined = no timeout). */
  timeout?: number;
  /** Override token budget (e.g. 300000 for heavy tasks). Overrides config value. */
  budget?: number;
  /** Output structured JSON instead of human-readable output. */
  json?: boolean;
  argv?: string[];
};

type RunResult = CommandResult<unknown>;

export function normalizeFiles(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.filter((file): file is string => typeof file === 'string');
  }
  return [];
}

function mediaTypeForPath(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case '.pdf': return 'application/pdf';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.png': return 'image/png';
    case '.webp': return 'image/webp';
    case '.gif': return 'image/gif';
    default: return 'application/octet-stream';
  }
}

export function parsePositiveNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim().length > 0
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function resolveTokenBudgetOverride<T extends { enabled?: boolean; maxTokens?: number }>(
  configured: T | undefined,
  override: unknown,
): T | { enabled: true; maxTokens: number } | undefined {
  const budgetTokens = parsePositiveNumber(override);
  return budgetTokens !== undefined
    ? { ...(configured ?? {}), enabled: true, maxTokens: budgetTokens }
    : configured;
}

function parseBooleanFlag(value: unknown, defaultValue: boolean): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) {return true;}
    if (['false', '0', 'no', 'n', 'off'].includes(normalized)) {return false;}
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  return defaultValue;
}

export default defineCommand({
  id: 'agent:run',
  description: 'Execute a task with autonomous agent (orchestrator + child agents)',

  handler: {
    async execute(ctx: PluginContextV3, input: RunInput): Promise<RunResult> {
      // V3: Flags may come wrapped in input.flags or passed directly
      const flags = ('flags' in input && typeof (input as { flags?: unknown }).flags === 'object' && (input as { flags?: unknown }).flags !== null)
        ? (input as { flags: RunInput }).flags
        : input;

      const {
        task,
        workingDir = ctx.cwd || process.cwd(),
        maxIterations = 200,
        temperature = 0.1,
        verbose: verboseRaw = true,
        quiet: quietRaw = false,
        detailed: detailedRaw = false,
        sessionId,
        tier = 'medium',
        mode = 'execute',
        complexity,
        files: filesRaw,
        attachments: attachmentPathsRaw,
        trace,
        approve: approveRaw = false,
        execute: executeRaw = false,
        spec: specRaw = false,
        'dry-run': dryRunRaw = false,
        debug: debugRaw = false,
        timeout: timeoutSeconds,
        budget: budgetOverride,
        json: jsonOutput = false,
      } = flags;

      const verbose = parseBooleanFlag(verboseRaw, true);
      const quiet = parseBooleanFlag(quietRaw, false);
      const detailed = parseBooleanFlag(detailedRaw, false);
      const approve = parseBooleanFlag(approveRaw, false);
      const executeAfterPlan = parseBooleanFlag(executeRaw, false);
      const spec = parseBooleanFlag(specRaw, false);
      const dryRun = parseBooleanFlag(dryRunRaw, false);
      const debug = parseBooleanFlag(debugRaw, false);
      const files = normalizeFiles(filesRaw);
      const attachmentPaths = normalizeFiles(attachmentPathsRaw);

      // Build an AbortController when --timeout is specified.
      // The signal is passed into AgentConfig so the runner can honour it.
      const timeoutSecs = parsePositiveNumber(timeoutSeconds);

      const abortController = timeoutSecs !== undefined ? new AbortController() : undefined;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

      if (abortController && timeoutSecs !== undefined) {
        timeoutHandle = setTimeout(() => {
          abortController.abort(
            new Error(`Agent execution timed out after ${timeoutSecs}s (--timeout=${timeoutSecs})`)
          );
        }, timeoutSecs * 1000);
        // Unref so the timer never prevents the Node.js process from exiting naturally
        // when the agent finishes before the deadline.
        timeoutHandle.unref?.();
      }

      // Helper: always clear the timer once execution finishes (success or error).
      const clearTimeout_ = () => {
        if (timeoutHandle !== undefined) {
          clearTimeout(timeoutHandle);
          timeoutHandle = undefined;
        }
      };

      // Allow --approve without --task when --session-id is provided (approve existing plan)
      if (!task) {
        if (approve && sessionId) {
          const sessionManager = new SessionManager(workingDir as string || ctx.cwd || process.cwd());
          const planPath = sessionManager.getSessionPlanPath(sessionId as string);
          try {
            const raw = await fs.readFile(planPath, 'utf-8');
            const plan: TaskPlan = JSON.parse(raw);
            if (plan.status !== 'draft') {
              ctx.ui?.warn?.(`Plan is not in draft state (current: ${plan.status}). Nothing to approve.`);
              clearTimeout_();
              return { ok: false, error: 'Command failed' };
            }
            const approvedAt = new Date().toISOString();
            const approvedPlan = { ...plan, status: 'approved' as const, approvedAt, approvalComment: 'Approved via CLI --approve', updatedAt: approvedAt };
            await fs.writeFile(planPath, JSON.stringify(approvedPlan, null, 2), 'utf-8');
            const planDocumentService = new PlanDocumentService(workingDir as string || ctx.cwd || process.cwd());
            const planDocPath = planDocumentService.getPlanPath(plan);
            await planDocumentService.appendExecutionLog(planDocPath, `- ${approvedAt}: Plan approved via CLI (--approve).`).catch(() => {});
            ctx.ui?.success?.(`Plan approved: ${approvedPlan.id} (session: ${sessionId})`);
            ctx.ui?.info?.(`Ready to execute: kb agent run --session-id=${sessionId}`);
            clearTimeout_();
            return { ok: true, result: { sessionId: sessionId as string } };
          } catch {
            if (jsonOutput) {
              ctx.ui?.json?.({ ok: false, error: { code: 'NO_PLAN', message: `No approved plan for session ${sessionId}` } });
            } else {
              ctx.ui?.error?.('No plan found for this session', {
                hint: `Run: kb agent run --session-id=${sessionId} --task "your task"`,
                cause: `Session ${sessionId} has no approved plan`,
              });
            }
            clearTimeout_();
            return { ok: false, error: 'Command failed' };
          }
        }
        ctx.ui?.error?.('Error: --task is required');
        clearTimeout_();
        return { ok: false, error: 'Command failed' };
      }

      // Build mode config
      let modeConfig: ModeConfig | undefined;
      if (mode !== 'execute') {
        modeConfig = { mode } as ModeConfig;

        // Add mode-specific context
        if (mode === 'plan') {
          modeConfig.context = { mode: 'plan', task, complexity };
        } else if (mode === 'edit') {
          modeConfig.context = { mode: 'edit', task, targetFiles: files || [], dryRun };
        } else if (mode === 'debug') {
          modeConfig.context = { mode: 'debug', task, traceFile: trace, relevantFiles: files || [] };
        }
      }

      // Select event renderer based on verbosity flags
      let eventRenderer;
      if (jsonOutput) {
        eventRenderer = () => {}; // Suppress all human output for JSON mode
      } else if (quiet) {
        eventRenderer = createMinimalRenderer();
      } else if (debug) {
        eventRenderer = createDebugRenderer();
      } else if (detailed) {
        eventRenderer = createDetailedRenderer();
      } else {
        eventRenderer = createEventRenderer({
          verbose,
          showToolOutput: true,
          showLLMContent: false,
        });
      }

      try {
        const uploads = await Promise.all(attachmentPaths.map(async (filePath): Promise<AgentAttachmentUpload> => {
          const bytes = await fs.readFile(filePath);
          return {
            name: path.basename(filePath),
            mediaType: mediaTypeForPath(filePath),
            data: bytes.toString('base64'),
          };
        }));
        const preparedAttachments = await prepareAgentAttachments(uploads);
        if (preparedAttachments.requiredCapabilities.length > 0 && !canUseLLMForMessages([{
          role: 'user',
          content: [{ type: 'text', text: task }, ...preparedAttachments.contentParts],
        }], { tier })) {
          throw new AgentAttachmentError(
            'AGENT_ATTACHMENT_MODEL_UNSUPPORTED',
            `No configured LLM in tier "${tier}" supports required capabilities: ${preparedAttachments.requiredCapabilities.join(', ')}. Configure a compatible model or choose another tier.`,
          );
        }

        const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const sessionManager = new SessionManager(workingDir);
        let effectiveSessionId = sessionId as string | undefined;

        // Ensure session exists for consistent history/memory behavior in CLI path.
        if (!effectiveSessionId) {
          const createdSession = await sessionManager.createSession({
            mode,
            task,
            agentId: 'cli-agent',
          });
          effectiveSessionId = createdSession.id;
        } else {
          const existing = await sessionManager.loadSession(effectiveSessionId);
          if (!existing) {
            const createdSession = await sessionManager.createSession({
              mode,
              task,
              agentId: 'cli-agent',
              sessionId: effectiveSessionId,
            });
            effectiveSessionId = createdSession.id;
          }
        }

        // Persist user turn first so timeline ordering is deterministic.
        await sessionManager.createUserTurn(effectiveSessionId, task, runId, undefined, preparedAttachments.references);

        // Create shared file tracking (for edit protection)
        const filesRead = new Set<string>();
        const filesReadHash = new Map<string, string>();
        const filesWritten = new Set<string>();
        const sessionMemory = createSessionMemoryBridge(workingDir, effectiveSessionId);
        const responseRequirementsSelector = createDefaultResponseRequirementsSelector();

        // Create tool registry
        const toolRegistry = createToolRegistry({
          workingDir,
          currentTask: task,
          sessionId: effectiveSessionId,
          verbose: false, // Disable tool registry verbose - we have event renderer
          cache: useCache(),
          filesRead,
          filesReadHash,
          filesWritten,
          abortSignal: abortController?.signal,
          sessionMemory,
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
        const agentsConfig = await useConfig<AgentsPluginConfig>();
        const effectiveBudget = resolveTokenBudgetOverride(agentsConfig?.tokenBudget, budgetOverride);
        const analytics = useAnalytics() ?? null;
        const taskId = `task-${Date.now()}`;
        const tracer = new IncrementalTraceWriter(taskId);

        // Spec-only fast path: skip plan mode, generate spec from existing approved plan
        if (spec && effectiveSessionId && sessionId) {
          const planPath = sessionManager.getSessionPlanPath(effectiveSessionId);
          try {
            const planData = JSON.parse(await fs.readFile(planPath, 'utf-8')) as TaskPlan;
            if (planData.status === 'approved' || planData.status === 'spec_ready') {
              ctx.ui?.info?.(`Found approved plan: ${planData.id} (${planData.phases.length} phases). Generating spec directly...`);
              let pendingSessionWrite: Promise<void> = Promise.resolve();
              const specEventCallback = (event: AgentEvent) => {
                tracer.trace(event as unknown as DetailedTraceEntry);
                eventRenderer(event);
                pendingSessionWrite = pendingSessionWrite
                  .then(async () => {
                    await sessionManager.addEvent(effectiveSessionId!, {
                      ...event,
                      sessionId: effectiveSessionId,
                      runId,
                      metadata: {
                        ...(event as unknown as Record<string, unknown>)['metadata'] as Record<string, unknown> | undefined,
                        sessionId: effectiveSessionId,
                        runId,
                        workingDir,
                      },
                    } as unknown as AgentEvent);
                  })
                  .catch((error) => {
                    const message = error instanceof Error ? error.message : String(error);
                    console.warn(`[agent:run] Failed to persist spec event: ${message}`);
                  });
              };
              const specConfig: AgentConfig = {
                workingDir,
                initialInputContentParts: preparedAttachments.contentParts,
                inputAttachments: preparedAttachments.references,
                maxIterations: 40,
                temperature: 0.1,
                sessionId: effectiveSessionId,
                tier,
                analytics,
                tokenBudget: effectiveBudget,
                platformMcp: agentsConfig?.platformMcp,
                onEvent: specEventCallback,
                abortSignal: abortController?.signal,
              };
              const specHandler = new SpecModeHandler();
              const specResult = await specHandler.execute(planData, specConfig, toolRegistry);
              await pendingSessionWrite;
              await tracer.finalize();
              const detailedTrace = tracer.getEntries() as unknown as Array<Record<string, unknown>>;
              if (detailedTrace.length > 0) {
                await sessionManager.storeTraceArtifacts(effectiveSessionId, runId, detailedTrace);
              }
              if (specResult.success) {
                ctx.ui?.success?.(`Spec generated: ${specResult.spec?.id} (${specResult.spec?.sections.length || 0} sections, ${specResult.spec?.sections.reduce((s, sec) => s + sec.changes.length, 0) || 0} changes)`);
              } else {
                ctx.ui?.warn?.(`Spec generation failed: ${specResult.summary}`);
              }
              const specSucceeded = specResult.success;
              clearTimeout_();
              return specSucceeded
                ? { ok: true, result: {
                    sessionId: effectiveSessionId,
                  success: specSucceeded,
                  summary: specResult.summary,
                  filesCreated: specResult.filesCreated,
                  filesModified: specResult.filesModified,
                  filesRead: specResult.filesRead,
                  iterations: specResult.iterations,
                  tokensUsed: specResult.tokensUsed,
                } }
                : { ok: false, error: 'Command failed', result: {
                    sessionId: effectiveSessionId,
                    success: specSucceeded,
                    summary: specResult.summary,
                    filesCreated: specResult.filesCreated,
                    filesModified: specResult.filesModified,
                    filesRead: specResult.filesRead,
                    iterations: 0,
                    tokensUsed: 0,
                  } };
            }
          } catch {
            // No plan.json or unreadable — fall through to normal flow
          }
        }

        // Track pending session writes so we can flush before exit
        let pendingSessionWrite: Promise<void> = Promise.resolve();
        let persistedEventCount = 0;

        // Create composite event callback that writes to tracer, renders UI, AND persists to session
        const compositeEventCallback = (event: AgentEvent) => {
          // Write to tracer
          tracer.trace(event as unknown as DetailedTraceEntry);
          // Render UI
          eventRenderer(event);
          // Persist to session for conversation history
          pendingSessionWrite = pendingSessionWrite
            .then(async () => {
              await sessionManager.addEvent(effectiveSessionId!, {
                ...event,
                sessionId: effectiveSessionId,
                runId,
              } as unknown as AgentEvent);
              persistedEventCount += 1;
            })
            .catch((error) => {
              const message = error instanceof Error ? error.message : String(error);
              console.warn(`[agent:run] Failed to persist event: ${message}`);
            });
        };

        // Create agent config with event callback
        const config: AgentConfig = {
          workingDir,
          initialInputContentParts: preparedAttachments.contentParts,
          inputAttachments: preparedAttachments.references,
          maxIterations,
          temperature,
          sessionId: effectiveSessionId,
          tier,
          analytics,
          tokenBudget: effectiveBudget,
          platformMcp: agentsConfig?.platformMcp,
          mode: modeConfig,
          onEvent: compositeEventCallback,
          debug,
          abortSignal: abortController?.signal,
        };

        // Announce the active timeout so the user knows about the deadline.
        if (timeoutSecs !== undefined && !quiet) {
          ctx.ui?.info?.(`⏱  Timeout active: agent will abort after ${timeoutSecs}s (--timeout=${timeoutSecs})`);
        }

        // Create and execute agent via SDK
        const sdk = new AgentSDK();
        sdk.register(createCoreToolPack(toolRegistry));
        const runner = sdk.createRunner(config);
        let result = await runner.execute(task);

        // Execution finished — cancel the timer immediately so it doesn't fire.
        clearTimeout_();

        // Flush pending session writes (ensures agent:end is persisted before exit)
        await pendingSessionWrite;

        // Some modes can complete without emitting event stream.
        // Persist synthetic assistant turn events so history stays complete.
        if (persistedEventCount === 0 && result.summary?.trim()) {
          const now = new Date().toISOString();
          const agentId = `agent-${runId}`;
          const baseMetadata = { sessionId: effectiveSessionId, runId, workingDir };
          await sessionManager.addEvent(effectiveSessionId, {
            type: 'agent:start',
            timestamp: now,
            sessionId: effectiveSessionId,
            agentId,
            runId,
            data: { task, tier, maxIterations, toolCount: 0 },
            metadata: baseMetadata,
          } as AgentEvent);
          await sessionManager.addEvent(effectiveSessionId, {
            type: 'llm:end',
            timestamp: now,
            sessionId: effectiveSessionId,
            agentId,
            runId,
            data: {
              content: result.summary,
              hasToolCalls: false,
              tokensUsed: 0,
              durationMs: 0,
              stopReason: 'no_tool_calls',
            },
            metadata: baseMetadata,
          } as AgentEvent);
          await sessionManager.addEvent(effectiveSessionId, {
            type: 'agent:end',
            timestamp: now,
            sessionId: effectiveSessionId,
            agentId,
            runId,
            data: {
              success: result.success,
              summary: result.summary,
              iterations: result.iterations,
              tokensUsed: result.tokensUsed,
              durationMs: 0,
              filesCreated: result.filesCreated,
              filesModified: result.filesModified,
              stopReason: result.success ? 'report_complete' : 'unknown',
            },
            metadata: baseMetadata,
          } as AgentEvent);
        }

        const detailedTrace = tracer.getEntries() as unknown as Array<Record<string, unknown>>;
        if (detailedTrace.length > 0) {
          await sessionManager.storeTraceArtifacts(effectiveSessionId, runId, detailedTrace);
        }

        // Attach file change summaries to turn for UI rollback/approve panel
        if (result.fileChanges && result.fileChanges.length > 0) {
          await sessionManager.attachFileChangesToTurn(effectiveSessionId, runId, result.fileChanges);
        }

        // Auto-approve generated plan in plan mode (--mode=plan --approve)
        if (approve) {
          if (mode !== 'plan') {
            ctx.ui?.warn?.('--approve is currently supported only with --mode=plan');
          } else if (!result.plan) {
            ctx.ui?.warn?.('No plan produced by plan mode, nothing to approve');
          } else {
            const approvedAt = new Date().toISOString();
            const approvedPlan = {
              ...result.plan,
              status: 'approved' as const,
              approvedAt,
              approvalComment: 'Approved via CLI --approve',
              updatedAt: approvedAt,
            };

            const sessionPlanPath = sessionManager.getSessionPlanPath(effectiveSessionId);
            await fs.writeFile(sessionPlanPath, JSON.stringify(approvedPlan, null, 2), 'utf-8');

            const planDocumentService = new PlanDocumentService(workingDir);
            const planDocPath = planDocumentService.getPlanPath(result.plan);
            await planDocumentService.appendExecutionLog(
              planDocPath,
              `- ${approvedAt}: Plan approved via CLI (--approve).`
            );

            ctx.ui?.success?.(`Plan approved: ${approvedPlan.id}`);

            if (executeAfterPlan) {
              // --execute: immediately run the approved plan in execute mode
              ctx.ui?.info?.('Executing approved plan...');
              const executeConfig: AgentConfig = {
                ...config,
                mode: { mode: 'execute' },
              };
              const executeSdk = new AgentSDK();
              executeSdk.register(createCoreToolPack(toolRegistry));
              const executeRunner = executeSdk.createRunner(executeConfig);
              result = await executeRunner.execute(task);
            } else {
              ctx.ui?.info?.(`Execute: kb agent run --session-id=${effectiveSessionId}`);
            }

            // Optional: generate spec after auto-approve
            if (spec && approvedPlan) {
              ctx.ui?.info?.('Generating detailed specification from approved plan...');
              const specHandler = new SpecModeHandler();
              const specResult = await specHandler.execute(approvedPlan, config, toolRegistry);

              if (specResult.success) {
                ctx.ui?.success?.(`Spec generated: ${specResult.spec?.id} (${specResult.spec?.sections.length || 0} sections)`);
              } else {
                ctx.ui?.warn?.(`Spec generation failed: ${specResult.summary}`);
              }
            }
          }
        }

        // Finalize tracer: generate index with memory stats, cleanup old traces
        await tracer.finalize();

        // Event renderer already showed the result via agent:end event
        // Just return the structured result

        const runSucceeded = result.success;
        const timeoutMessage = abortController?.signal.aborted
          ? abortController.signal.reason instanceof Error
            ? abortController.signal.reason.message
            : `Agent execution timed out after ${timeoutSecs ?? 'unknown'}s`
          : undefined;
        const structuredResult = runSucceeded
          ? { ok: true as const, result: {
            sessionId: effectiveSessionId,
            success: runSucceeded,
            summary: result.summary,
            filesCreated: result.filesCreated,
            filesModified: result.filesModified,
            filesRead: result.filesRead,
            iterations: result.iterations,
            tokensUsed: result.tokensUsed,
            hasPlan: mode === 'plan' && !!result.plan,
          } }
          : { ok: false as const, error: timeoutMessage
            ? { code: 'TIMEOUT', message: timeoutMessage }
            : 'Command failed', result: {
            sessionId: effectiveSessionId,
            success: runSucceeded,
            summary: result.summary,
            filesCreated: result.filesCreated,
            filesModified: result.filesModified,
            filesRead: result.filesRead,
            iterations: result.iterations,
            tokensUsed: result.tokensUsed,
            hasPlan: mode === 'plan' && !!result.plan,
          } };

        if (jsonOutput) {
          ctx.ui?.json?.(structuredResult);
        }

        return structuredResult;
      } catch (error) {
        clearTimeout_();
        // Surface a clear message when the timeout fired.
        if (abortController?.signal.aborted) {
          const reason = abortController.signal.reason instanceof Error
            ? abortController.signal.reason.message
            : `Agent execution timed out after ${timeoutSecs}s`;
          if (jsonOutput) {
            ctx.ui?.json?.({ ok: false, error: { code: 'TIMEOUT', message: reason } });
          } else {
            ctx.ui?.error?.('Agent execution timed out', {
              hint: 'Check agent logs with: kb agent logs --session-id <id>',
              cause: reason,
            });
          }
          return { ok: false, error: 'Command timed out' };
        }
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (jsonOutput) {
          ctx.ui?.json?.({ ok: false, error: { code: 'EXECUTION_FAILED', message: errorMessage } });
        } else {
          ctx.ui?.error?.('Agent execution failed', {
            hint: 'Check agent logs with: kb agent logs --session-id <id>',
            cause: errorMessage,
          });
        }
        return { ok: false, error: 'Command failed' };
      }
    },
  },
});
