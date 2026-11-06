/**
 * GET /sessions/:sessionId/plan
 * Get current session plan (JSON + canonical markdown path if present).
 */

import { defineHandler, rethrowForRest, type RestInput, type PluginContextV3 } from '@kb-labs/sdk';
import { SessionManager, PlanDocumentService } from '../../core/index.js';
import type { GetSessionPlanResponse, TaskPlan } from '../../contracts/index.js';
import { promises as fs } from 'node:fs';
import { agentSessionNotFound } from './session-errors.js';

interface GetSessionPlanRequest {
  sessionId?: string;
}

async function loadPlan(planPath: string): Promise<TaskPlan | null> {
  try {
    const content = await fs.readFile(planPath, 'utf-8');
    return JSON.parse(content) as TaskPlan;
  } catch {
    return null;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export default defineHandler({
  async execute(
    ctx: PluginContextV3,
    input: RestInput<GetSessionPlanRequest>
  ): Promise<GetSessionPlanResponse> {
    try {
      const params = input.params as Record<string, string> | undefined;
      const sessionId = params?.sessionId;
      if (!sessionId) {
        throw new Error('Session ID is required');
      }

      const sessionManager = new SessionManager(ctx.cwd);
      const session = await sessionManager.loadSession(sessionId);
      if (!session) {
        throw agentSessionNotFound(sessionId);
      }

      const workingDir = session.workingDir || ctx.cwd;
      const manager = new SessionManager(workingDir);
      const planPath = manager.getSessionPlanPath(sessionId);
      const plan = await loadPlan(planPath);

      if (!plan) {
        return { sessionId, plan: null };
      }

      const documentService = new PlanDocumentService(workingDir);
      const canonicalPath = documentService.getPlanPath(plan);

      return {
        sessionId,
        plan,
        planPath: await pathExists(canonicalPath) ? canonicalPath : undefined,
      };
    } catch (err) {
      rethrowForRest(err);
    }
  },
});
