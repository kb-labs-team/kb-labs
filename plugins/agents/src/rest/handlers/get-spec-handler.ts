/**
 * GET /sessions/:sessionId/spec
 * Get current session spec (JSON + markdown path if present).
 */

import { defineHandler, rethrowForRest, type RestInput, type PluginContextV3 } from '@kb-labs/sdk';
import { SessionManager } from '../../core/index.js';
import type { GetSpecResponse, TaskSpec } from '../../contracts/index.js';
import { promises as fs } from 'node:fs';
import { agentSessionNotFound } from './session-errors.js';

interface GetSpecRouteParams {
  sessionId?: string;
}

async function loadSpec(specPath: string): Promise<TaskSpec | null> {
  try {
    const content = await fs.readFile(specPath, 'utf-8');
    return JSON.parse(content) as TaskSpec;
  } catch {
    return null;
  }
}

export default defineHandler({
  async execute(
    ctx: PluginContextV3,
    input: RestInput<unknown, unknown, GetSpecRouteParams>
  ): Promise<GetSpecResponse> {
    try {
      const params = input.params as Record<string, string> | undefined;
      const sessionId = params?.sessionId;
      if (!sessionId) {
        throw new Error('Session ID is required');
      }

      const baseManager = new SessionManager(ctx.cwd);
      const session = await baseManager.loadSession(sessionId);
      if (!session) {
        throw agentSessionNotFound(sessionId);
      }

      const workingDir = session.workingDir || ctx.cwd;
      const manager = new SessionManager(workingDir);
      const specPath = manager.getSessionSpecPath(sessionId);
      const spec = await loadSpec(specPath);

      return {
        sessionId,
        spec,
      };
    } catch (err) {
      rethrowForRest(err);
    }
  },
});
