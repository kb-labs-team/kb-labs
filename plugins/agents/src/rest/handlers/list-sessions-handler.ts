/**
 * GET /sessions - List all sessions
 */

import { defineHandler, rethrowForRest, type RestInput, type PluginContextV3 } from '@kb-labs/sdk';
import { SessionManager } from '../../core/index.js';
import type { ListSessionsRequest, ListSessionsResponse } from '../../contracts/index.js';

export default defineHandler({
  async execute(
    ctx: PluginContextV3,
    input: RestInput<ListSessionsRequest>
  ): Promise<ListSessionsResponse> {
    try {
      const query = input.query as ListSessionsRequest | undefined;
      const sessionManager = new SessionManager(ctx.cwd);

      // List all sessions (optionally filtered by status)
      const result = await sessionManager.listSessions({
        status: query?.status,
        limit: query?.limit ?? 50,
        offset: query?.offset ?? 0,
      });

      return {
        sessions: result.sessions,
        total: result.total,
      };
    } catch (err) {
      rethrowForRest(err);
    }
  },
});
