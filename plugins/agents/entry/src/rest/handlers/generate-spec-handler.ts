/**
 * POST /sessions/:sessionId/plan/spec
 * Generate a detailed specification from an approved session plan.
 */

import { defineHandler, rethrowForRest, type RestInput, type PluginContextV3 } from '@kb-labs/sdk';
import { SessionManager, SpecModeHandler, createSessionMemoryBridge } from '@kb-labs/agent-core';
import { createDefaultResponseRequirementsSelector } from '@kb-labs/agent-runtime';
import { IncrementalTraceWriter, resolveTraceDir } from '@kb-labs/agent-tracing';
import { createToolRegistry } from '@kb-labs/agent-tools';
import type {
  AgentEvent,
  DetailedTraceEntry,
  GenerateSpecRequest,
  GenerateSpecResponse,
  KernelState,
  TaskPlan,
} from '@kb-labs/agent-contracts';
import { promises as fs } from 'node:fs';
import { RunManager } from '../run-manager.js';

interface SpecRouteParams {
  sessionId?: string;
}

async function loadPlan(planPath: string): Promise<TaskPlan> {
  const content = await fs.readFile(planPath, 'utf-8');
  return JSON.parse(content) as TaskPlan;
}

export default defineHandler({
  async execute(
    ctx: PluginContextV3,
    input: RestInput<GenerateSpecRequest, unknown, SpecRouteParams>
  ): Promise<GenerateSpecResponse> {
    try {
      const params = input.params as Record<string, string> | undefined;
      const sessionId = params?.sessionId;
      const body = (input.body ?? {}) as GenerateSpecRequest;

      if (!sessionId) {
        throw new Error('Session ID is required');
      }

      const baseManager = new SessionManager(ctx.cwd);
      const session = await baseManager.loadSession(sessionId);
      if (!session) {
        throw new Error(`Session not found: ${sessionId}`);
      }

      const workingDir = session.workingDir || ctx.cwd;
      const sessionManager = new SessionManager(workingDir);
      const planPath = sessionManager.getSessionPlanPath(sessionId);

      let plan: TaskPlan;
      try {
        plan = await loadPlan(planPath);
      } catch {
        throw new Error(`Plan not found for session ${sessionId}`);
      }

      if (plan.status !== 'approved') {
        throw new Error(`Plan must be approved before spec generation (current status: ${plan.status})`);
      }

      // Run spec generation asynchronously via RunManager
      const runId = `run-spec-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const startedAt = new Date().toISOString();
      const traceDir = resolveTraceDir(workingDir);
      const traceWriter = new IncrementalTraceWriter(runId, {}, traceDir);
      await RunManager.register(
        runId,
        `Generate spec for plan ${plan.id}`,
        undefined,
        sessionManager,
      );
      await RunManager.updateStatus(runId, 'running');

      // Start spec generation in background
      const specHandler = new SpecModeHandler();
      const sessionMemory = createSessionMemoryBridge(workingDir, sessionId);
      const responseRequirementsSelector = createDefaultResponseRequirementsSelector();
      const toolRegistry = createToolRegistry({
        workingDir,
        currentTask: `Generate spec for plan ${plan.id}`,
        sessionId,
        sessionMemory,
        responseRequirementsResolver: async ({ task, kernel }: {
          task?: string;
          answer: string;
          kernel: KernelState | null;
        }) =>
          responseRequirementsSelector.select({
            state: kernel,
            messages: [],
            task: task ?? `Generate spec for plan ${plan.id}`,
          }),
      });

      const specPromise = (async () => {
        const configOnEvent = (event: AgentEvent) => {
          traceWriter.trace(event as unknown as DetailedTraceEntry);
          // Persist first, broadcast only once confirmed — see run-handler.ts's onEvent for why.
          void sessionManager.addEvent(sessionId, {
            ...event,
            sessionId,
            runId,
          } as unknown as AgentEvent).then((deltas) => {
            RunManager.broadcastSessionDeltas(sessionId, deltas);
          });
        };

        const specStartTime = Date.now();
        try {
          const result = await specHandler.execute(plan, {
            workingDir,
            sessionId,
            agentId: `spec-${sessionId}`,
            maxIterations: plan.phases.length * 8,
            tier: body.tier || 'medium',
            temperature: 0.1,
            onEvent: configOnEvent,
          }, toolRegistry);
          await RunManager.updateStatus(runId, result.success ? 'completed' : 'failed', {
            completedAt: new Date().toISOString(),
            summary: result.summary,
            error: result.success ? undefined : result.summary,
          });
          const seq = await sessionManager.getCurrentSessionSeq(sessionId);
          RunManager.broadcastRunCompleted(sessionId, {
            runId,
            success: result.success,
            summary: result.summary,
            durationMs: Date.now() - specStartTime,
            seq,
          });
          return result;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await RunManager.updateStatus(runId, 'failed', {
            completedAt: new Date().toISOString(),
            summary: message,
            error: message,
          });
          const seq = await sessionManager.getCurrentSessionSeq(sessionId);
          RunManager.broadcastRunCompleted(sessionId, {
            runId,
            success: false,
            summary: message,
            durationMs: Date.now() - specStartTime,
            seq,
          });
          throw error;
        } finally {
          const detailedTrace = traceWriter.getEntries() as unknown as Array<Record<string, unknown>>;
          await traceWriter.finalize?.();
          if (detailedTrace.length > 0) {
            await sessionManager.storeTraceArtifacts(sessionId, runId, detailedTrace);
          }
        }
      })();

      void specPromise;

      return {
        sessionId,
        planId: plan.id,
        specId: `spec-${runId}`,
        runId,
        eventsPath: `/ws/plugins/agents/session/${sessionId}`,
        status: 'generating',
        startedAt,
      };
    } catch (err) {
      rethrowForRest(err);
    }
  },
});
