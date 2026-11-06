/**
 * GET /sessions/:sessionId/turns - Get session turns (turn-based UI)
 * NEW (Phase 2): Returns ready-made Turn snapshots instead of raw events
 */

import { defineHandler, rethrowForRest, type RestInput, type PluginContextV3 } from '@kb-labs/sdk';
import { SessionManager } from '../../core/index.js';
import type { Turn } from '../../contracts/index.js';
import { agentSessionNotFound } from './session-errors.js';

interface GetSessionTurnsRequest {
  sessionId?: string;
  limit?: number;
  offset?: number;
}

interface GetSessionTurnsResponse {
  turns: Turn[];
  total: number;
}

export default defineHandler({
  async execute(
    ctx: PluginContextV3,
    input: RestInput<GetSessionTurnsRequest>
  ): Promise<GetSessionTurnsResponse> {
    try {
      const params = input.params as Record<string, string> | undefined;
      const sessionId = params?.sessionId;
      const query = input.query as Partial<GetSessionTurnsRequest> | undefined;

      if (!sessionId) {
        throw new Error('Session ID is required');
      }

      const sessionManager = new SessionManager(ctx.cwd);

      ctx.platform.logger.info(`[get-session-turns] cwd: ${ctx.cwd}, sessionId: ${sessionId}`);
      ctx.platform.logger.info(`[get-session-turns] turnsPath: ${sessionManager.getTurnsPath(sessionId)}`);

      // Verify session exists
      const session = await sessionManager.loadSession(sessionId);
      if (!session) {
        throw agentSessionNotFound(sessionId);
      }

      // Get turns (with lazy migration from events if needed)
      let turns = await sessionManager.getTurns(sessionId);

      ctx.platform.logger.info(`[get-session-turns] Found ${turns.length} turns`);

      // Apply pagination
      const total = turns.length;
      if (query?.offset) {
        turns = turns.slice(query.offset);
      }
      if (query?.limit) {
        turns = turns.slice(0, query.limit);
      }

      return { turns, total };
    } catch (err) {
      rethrowForRest(err);
    }
  },
});
