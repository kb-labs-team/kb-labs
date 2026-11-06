/**
 * GET /sessions/:sessionId - Get session details
 */

import { defineHandler, rethrowForRest, type RestInput, type PluginContextV3 } from '@kb-labs/sdk';
import { SessionManager } from '../../core/index.js';
import type { GetSessionResponse } from '../../contracts/index.js';
import { agentSessionNotFound } from './session-errors.js';

interface GetSessionRequest {
  sessionId?: string;
}

export default defineHandler({
  async execute(
    ctx: PluginContextV3,
    input: RestInput<GetSessionRequest>
  ): Promise<GetSessionResponse> {
    try {
      const params = input.params as Record<string, string> | undefined;
      const sessionId = params?.sessionId;

      if (!sessionId) {
        throw new Error('Session ID is required');
      }

      const sessionManager = new SessionManager(ctx.cwd);
      const session = await sessionManager.getSessionInfo(sessionId);

      if (!session) {
        throw agentSessionNotFound(sessionId);
      }

      return { session };
    } catch (err) {
      rethrowForRest(err);
    }
  },
});
