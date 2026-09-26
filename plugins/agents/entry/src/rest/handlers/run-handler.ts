/**
 * POST /run handler
 *
 * Starts a new agent run via Orchestrator
 */

import { defineHandler, rethrowForRest, useAnalytics, useCache, useConfig, type RestInput, type PluginContextV3 } from '@kb-labs/sdk';
import { SessionManager, createCoreToolPack, bootstrapAgentSDK, createSessionMemoryBridge } from '@kb-labs/agent-core';
import { createDefaultResponseRequirementsSelector } from '@kb-labs/agent-runtime';
import { IncrementalTraceWriter, resolveTraceDir } from '@kb-labs/agent-tracing';

// Register SDKAgentRunner as the RunnerFactory (idempotent — runs once per process)
bootstrapAgentSDK();
import { AgentSDK } from '@kb-labs/agent-sdk';
import { createToolRegistry } from '@kb-labs/agent-tools';
import type { RunRequest, RunResponse, AgentsPluginConfig, KernelState } from '@kb-labs/agent-contracts';
import path from 'node:path';
import fs from 'node:fs';
import {
  AGENTS_WS_BASE_PATH,
  AGENTS_WS_CHANNELS,
  AGENT_ANALYTICS_EVENTS,
} from '@kb-labs/agent-contracts';
import { RunManager } from '../run-manager.js';

const FOLLOW_UP_SCOPE_RE = /\b(глубже|подробнее|детал|слишком поверхност|deeper|more depth|details?)\b/i;

function isLikelyFollowUpScopeTask(task: string): boolean {
  return FOLLOW_UP_SCOPE_RE.test(task);
}

function pathExists(dir: string): boolean {
  try {
    return fs.existsSync(dir);
  } catch {
    return false;
  }
}

function scoreRepoFromToolPath(rawPath: string, scores: Map<string, number>): void {
  const p = rawPath.replace(/\\/g, '/');

  // Explicit repo prefix: kb-labs-xxx/...
  const explicit = p.match(/(^|\/)(kb-labs-[^/]+)\//);
  if (explicit?.[2]) {
    scores.set(explicit[2], (scores.get(explicit[2]) ?? 0) + 5);
  }

  // Heuristic by package naming patterns
  if (p.startsWith('packages/')) {
    if (/packages\/agent[-/]/.test(p) || /agent-core|agent-tools|agent-cli|agent-task-runner/.test(p)) {
      scores.set('kb-labs-agents', (scores.get('kb-labs-agents') ?? 0) + 4);
    }
    if (/packages\/mind[-/]/.test(p) || /mind-engine|mind-core/.test(p)) {
      scores.set('kb-labs-mind', (scores.get('kb-labs-mind') ?? 0) + 4);
    }
  }
}

async function inferFollowUpWorkingDir(
  sessionManager: SessionManager,
  sessionId: string,
  baseWorkingDir: string,
): Promise<string | null> {
  const events = await sessionManager.getSessionEvents(sessionId);
  if (!events.length) {
    return null;
  }

  // Find the latest completed run in this session
  const completedRuns = new Set<string>();
  for (const event of events) {
    if (event.type === 'agent:end' && event.runId) {
      completedRuns.add(event.runId);
    }
  }
  const lastRunId = Array.from(completedRuns).at(-1);
  if (!lastRunId) {
    return null;
  }

  const repoScores = new Map<string, number>();
  for (const event of events) {
    if (event.runId !== lastRunId) {
      continue;
    }

    if (event.type === 'tool:start') {
      const input = (event.data?.input as Record<string, unknown> | undefined) ?? {};
      const p1 = input.path;
      const p2 = input.directory;
      if (typeof p1 === 'string') {scoreRepoFromToolPath(p1, repoScores);}
      if (typeof p2 === 'string') {scoreRepoFromToolPath(p2, repoScores);}
    }

    if (event.type === 'tool:end') {
      const metadata = (event.data?.metadata as Record<string, unknown> | undefined) ?? {};
      const p = metadata.path;
      if (typeof p === 'string') {scoreRepoFromToolPath(p, repoScores);}
    }
  }

  const ranked = Array.from(repoScores.entries()).sort((a, b) => b[1] - a[1]);
  const top = ranked[0];
  if (!top || top[1] < 4) {
    return null;
  }

  const inferredDir = path.join(baseWorkingDir, top[0]);
  return pathExists(inferredDir) ? inferredDir : null;
}

export default defineHandler({
  async execute(
    ctx: PluginContextV3,
    input: RestInput<RunRequest>
  ): Promise<RunResponse> {
    try {
    const body = input.body as RunRequest | undefined;

    if (!body?.task) {
      throw new Error('Task is required');
    }

    const analytics = useAnalytics();
    const runId = RunManager.generateRunId();
    const startTime = Date.now();

    // Get or create session
    let sessionId = body.sessionId;
    let workingDir = body.workingDir || ctx.cwd;
    let sessionManager = new SessionManager(workingDir);
    if (!sessionId) {
      // Create new session
      const session = await sessionManager.createSession({
        mode: 'execute',
        task: body.task,
        agentId: body.agentId ?? 'orchestrator',
      });
      sessionId = session.id;
      ctx.platform.logger.info(`[run-handler] Created new session ${sessionId}`);
    } else {
      // Verify session exists (from current manager first)
      const existingSession = await sessionManager.loadSession(sessionId);
      let resolvedSession = existingSession;

      // Fallback: session may belong to a different root than current ctx.cwd
      if (!resolvedSession && pathExists(ctx.cwd)) {
        const fallbackManager = new SessionManager(ctx.cwd);
        const fallbackSession = await fallbackManager.loadSession(sessionId);
        if (fallbackSession) {
          sessionManager = fallbackManager;
          resolvedSession = fallbackSession;
        }
      }

      if (!resolvedSession) {
        throw new Error(`Session not found: ${sessionId} (cwd=${ctx.cwd})`);
      }

      // Session workingDir is primary source of truth for follow-up runs
      workingDir = body.workingDir || resolvedSession.workingDir || workingDir;

      // Smart follow-up anchoring: keep depth requests in the same repo/module as previous run
      if (!body.workingDir && isLikelyFollowUpScopeTask(body.task)) {
        const inferred = await inferFollowUpWorkingDir(sessionManager, sessionId, resolvedSession.workingDir || ctx.cwd);
        if (inferred && inferred !== workingDir) {
          ctx.platform.logger.info(`[run-handler] Follow-up scope inferred: ${workingDir} -> ${inferred}`);
          workingDir = inferred;
        }
      }

      // Rebind session manager to effective working directory
      sessionManager = new SessionManager(workingDir);
      ctx.platform.logger.info(`[run-handler] Continuing session ${sessionId} (workingDir=${workingDir})`);
    }

    ctx.platform.logger.info(`[run-handler] Starting run ${runId} for task: ${body.task}`);

    // Create user turn with task/question
    const userTurn = await sessionManager.createUserTurn(sessionId, body.task, runId, body.clientId);

    // Track run started
    await analytics?.track(AGENT_ANALYTICS_EVENTS.RUN_STARTED, {
      runId,
      sessionId,
      taskLength: body.task.length,
      tier: body.tier ?? 'medium',
      enableEscalation: body.enableEscalation ?? true,
      responseMode: body.responseMode ?? 'auto',
      verbose: body.verbose ?? false,
    });

    // Create tool registry with standard tools
    const sessionMemory = createSessionMemoryBridge(workingDir, sessionId);
    const responseRequirementsSelector = createDefaultResponseRequirementsSelector();
    const toolRegistry = createToolRegistry({
      workingDir,
      currentTask: body.task,
      sessionId,
      verbose: body.verbose,
      cache: useCache(),
      sessionMemory,
      responseRequirementsResolver: async ({ task, kernel }: {
        task?: string;
        answer: string;
        kernel: KernelState | null;
      }) =>
        responseRequirementsSelector.select({
          state: kernel,
          messages: [],
          task: task ?? body.task,
        }),
    });
    const agentsConfig = await useConfig<AgentsPluginConfig>();

    const finalSessionId = sessionId; // Capture for closure
    const traceDir = resolveTraceDir(workingDir);
    const traceWriter = new IncrementalTraceWriter(runId, {}, traceDir);

    // Create agent with event broadcasting and session persistence
    const agent = new AgentSDK()
      .register(createCoreToolPack(toolRegistry))
      .createRunner({
        sessionId: finalSessionId,
        workingDir,
        maxIterations: 50,
        temperature: 0.1,
        tier: body.tier ?? 'medium',
        tokenBudget: agentsConfig?.tokenBudget,
        onEvent: (event) => {
          // Persist FIRST, broadcast only once that's confirmed — deltas are
          // computed from what was actually written, so a WS listener can
          // never observe turn state that isn't safely on disk yet. This
          // ordering (previously reversed: broadcast raced ahead of persist)
          // was the root cause of the WS stream silently lagging one event
          // behind the true state.
          void sessionManager.addEvent(finalSessionId, {
            ...event,
            sessionId: finalSessionId,
            runId,
            metadata: {
              ...event.metadata,
              sessionId: finalSessionId,
              runId,
              workingDir,
            },
          }).then((deltas) => {
            RunManager.broadcastSessionDeltas(finalSessionId, deltas);
          });
        },
      });

    // Register run (session-level WS listeners are registered separately via addSessionListener)
    const run = await RunManager.register(runId, body.task, agent, sessionManager);
    await RunManager.updateStatus(runId, 'running');

    // Start execution in background (don't await)
    void (async () => {
      try {
        const result = await agent.execute(body.task);
        const durationMs = Date.now() - startTime;
        const detailedTrace = traceWriter.getEntries() as unknown as Array<Record<string, unknown>>;
        await traceWriter.finalize?.();

        if (detailedTrace.length > 0) {
          await sessionManager.storeTraceArtifacts(finalSessionId, runId, detailedTrace);
        }

        // Attach file change summaries to the turn so the UI can show rollback/approve panel
        // Populated by ChangeTrackingMiddleware via run.meta → TaskResult.fileChanges
        if (result.fileChanges && result.fileChanges.length > 0) {
          await sessionManager.attachFileChangesToTurn(finalSessionId, runId, result.fileChanges);
        }

        await RunManager.updateStatus(runId, result.success ? 'completed' : 'failed', {
          completedAt: new Date().toISOString(),
          durationMs,
          summary: result.summary,
          error: result.error,
        });

        // The terminal WS signal fires from here — the run's own completion
        // handler, which has definitive success/summary/duration — rather
        // than being derived reactively from an agent:end event on the WS
        // side. Carries the final assistant turn (if this run produced one)
        // so the client has a guaranteed-fresh terminal state without
        // depending on delta message ordering.
        const finalTurns = await sessionManager.getTurns(finalSessionId);
        const finalTurn = finalTurns.find((t) => t.type === 'assistant' && t.metadata.runId === runId);
        const seq = await sessionManager.getCurrentSessionSeq(finalSessionId);
        RunManager.broadcastRunCompleted(finalSessionId, {
          runId,
          success: result.success,
          summary: result.summary,
          durationMs,
          seq,
          turn: finalTurn,
        });

        // Track completion
        await analytics?.track(
          result.success ? AGENT_ANALYTICS_EVENTS.RUN_COMPLETED : AGENT_ANALYTICS_EVENTS.RUN_FAILED,
          {
            runId,
            durationMs,
            success: result.success,
            summary: result.summary?.slice(0, 200),
          }
        );

        ctx.platform.logger.info(`[run-handler] Run ${runId} completed: ${result.success}`);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        const durationMs = Date.now() - startTime;
        const detailedTrace = traceWriter.getEntries() as unknown as Array<Record<string, unknown>>;
        await traceWriter.finalize?.();
        if (detailedTrace.length > 0) {
          await sessionManager.storeTraceArtifacts(finalSessionId, runId, detailedTrace);
        }

        await RunManager.updateStatus(runId, 'failed', {
          completedAt: new Date().toISOString(),
          durationMs,
          error: errorMsg,
        });

        const seq = await sessionManager.getCurrentSessionSeq(finalSessionId);
        RunManager.broadcastRunCompleted(finalSessionId, {
          runId,
          success: false,
          summary: errorMsg,
          durationMs,
          seq,
        });

        // Track failure
        await analytics?.track(AGENT_ANALYTICS_EVENTS.RUN_FAILED, {
          runId,
          durationMs,
          error: errorMsg.slice(0, 200),
        });

        ctx.platform.logger.error(`[run-handler] Run ${runId} failed: ${errorMsg}`);
      }
    })();

    // Return relative WS path — clients construct the full URL from their own base URL.
    const wsPath = AGENTS_WS_CHANNELS.SESSION_STREAM.replace(':sessionId', finalSessionId);
    const eventsPath = `${AGENTS_WS_BASE_PATH}${wsPath}`;

    return {
      runId,
      sessionId: finalSessionId,
      eventsPath,
      status: 'started',
      startedAt: run.startedAt,
      userTurn,
    };
    } catch (err) {
      rethrowForRest(err);
    }
  },
});
