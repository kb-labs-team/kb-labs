/**
 * POST /sessions/:sessionId/plan/execute
 * Execute approved session plan via standard run-handler pipeline.
 */

import { defineHandler, rethrowForRest, type RestInput, type PluginContextV3 } from '@kb-labs/sdk';
import { PlanDocumentService, SessionManager } from '../../core/index.js';
import type {
  ExecuteSessionPlanRequest,
  ExecuteSessionPlanResponse,
  RunRequest,
  RunResponse,
  TaskPlan,
  TaskSpec,
} from '../../contracts/index.js';
import { promises as fs } from 'node:fs';
import runHandler from './run-handler.js';
import { agentSessionNotFound } from './session-errors.js';

interface ExecutePlanRouteParams {
  sessionId?: string;
}

async function loadPlan(planPath: string): Promise<TaskPlan> {
  const content = await fs.readFile(planPath, 'utf-8');
  return JSON.parse(content) as TaskPlan;
}

function buildExecutionTask(plan: TaskPlan): string {
  const phaseLines = plan.phases.map((phase, idx) => {
    const steps = phase.steps
      .map((step, stepIdx) => {
        const tool = step.tool || 'n/a';
        return `    ${stepIdx + 1}. ${step.action} [tool: ${tool}]`;
      })
      .join('\n');
    return `${idx + 1}. ${phase.name}\n${steps || '    (no steps)'}`;
  }).join('\n');

  return [
    `Execute the approved implementation plan for task: ${plan.task}`,
    '',
    'Follow phase order and dependencies. Update progress with concrete results.',
    '',
    `Plan ID: ${plan.id}`,
    `Complexity: ${plan.complexity}`,
    `Estimated Duration: ${plan.estimatedDuration || 'Unknown'}`,
    '',
    'Phases:',
    phaseLines,
    '',
    'Requirements:',
    '- Execute plan steps pragmatically; adapt only when blocked.',
    '- Keep outputs concrete: changed files, commands run, verification results.',
  ].join('\n');
}

function buildExecutionTaskWithSpec(plan: TaskPlan, spec: TaskSpec): string {
  return [
    `Execute the approved implementation plan for task: ${plan.task}`,
    '',
    `Plan ID: ${plan.id}`,
    `Complexity: ${plan.complexity}`,
    '',
    '## DETAILED SPECIFICATION (exact changes)',
    '',
    'A detailed spec was generated and verified. Apply these exact changes:',
    '',
    spec.markdown || '(no spec markdown available)',
    '',
    'Requirements:',
    '- Apply the before/after diffs from the spec as precisely as possible.',
    '- Verify each change after applying it.',
    '- If the spec code doesn\'t match the current file (file was modified since spec), adapt minimally.',
    '- Keep outputs concrete: changed files, commands run, verification results.',
  ].join('\n');
}

export default defineHandler({
  async execute(
    ctx: PluginContextV3,
    input: RestInput<ExecuteSessionPlanRequest, unknown, ExecutePlanRouteParams>
  ): Promise<ExecuteSessionPlanResponse> {
    try {
      const params = input.params as Record<string, string> | undefined;
      const sessionId = params?.sessionId;
      const body = (input.body ?? {}) as ExecuteSessionPlanRequest;

      if (!sessionId) {
        throw new Error('Session ID is required');
      }

      const baseManager = new SessionManager(ctx.cwd);
      const session = await baseManager.loadSession(sessionId);
      if (!session) {
        throw agentSessionNotFound(sessionId);
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

      if (plan.status !== 'approved' && plan.status !== 'spec_ready') {
        throw new Error(`Plan must be approved before execution (current status: ${plan.status})`);
      }

      // Load spec if available — provides exact diffs for the execution agent
      let spec: TaskSpec | null = null;
      try {
        const specPath = sessionManager.getSessionSpecPath(sessionId);
        const specContent = await fs.readFile(specPath, 'utf-8');
        spec = JSON.parse(specContent) as TaskSpec;
      } catch {
        // No spec — execute from plan only
      }

      const executionTask = spec?.markdown
        ? buildExecutionTaskWithSpec(plan, spec)
        : buildExecutionTask(plan);
      const runInput: RestInput<unknown, RunRequest> = {
        body: {
          task: executionTask,
          sessionId,
          workingDir,
          tier: body.tier,
          responseMode: body.responseMode,
          verbose: body.verbose,
          enableEscalation: body.enableEscalation,
        },
      };

      const runResponse = await (runHandler as unknown as {
        execute: (ctx: PluginContextV3, input: RestInput<unknown, RunRequest>) => Promise<RunResponse>;
      }).execute(ctx, runInput);

      const inProgressPlan: TaskPlan = {
        ...plan,
        status: 'in_progress',
        updatedAt: new Date().toISOString(),
      };
      await fs.writeFile(planPath, JSON.stringify(inProgressPlan, null, 2), 'utf-8');

      const documentService = new PlanDocumentService(workingDir);
      const markdownPath = documentService.getPlanPath(plan);
      await documentService.appendExecutionLog(
        markdownPath,
        `- ${new Date().toISOString()}: Execution started (runId: ${runResponse.runId}).`
      );

      return {
        sessionId,
        planId: plan.id,
        runId: runResponse.runId,
        eventsPath: runResponse.eventsPath,
        status: runResponse.status,
        startedAt: runResponse.startedAt,
      };
    } catch (err) {
      rethrowForRest(err);
    }
  },
});
