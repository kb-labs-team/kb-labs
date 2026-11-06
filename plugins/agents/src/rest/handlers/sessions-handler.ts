/**
 * Session management REST handlers
 */

import { defineHandler, PluginError, rethrowForRest, type RestInput, type PluginContextV3 } from '@kb-labs/sdk';
import { globalAgentRegistry, SessionManager } from '../../core/index.js';
import type {
  ListSessionsRequest,
  ListSessionsResponse,
  GetSessionRequest,
  GetSessionResponse,
  CreateSessionRequest,
  CreateSessionResponse,
} from '../../contracts/index.js';
import { agentSessionNotFound } from './session-errors.js';

/**
 * GET /sessions - List all sessions
 */
export const listSessionsHandler = defineHandler({
  async execute(
    ctx: PluginContextV3,
    input: RestInput<ListSessionsRequest>
  ): Promise<ListSessionsResponse> {
    try {
      const query = input.query as ListSessionsRequest | undefined;
      const sessionManager = new SessionManager(ctx.cwd);

      const result = await sessionManager.listSessions({
        agentId: query?.agentId,
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

/**
 * GET /sessions/:sessionId - Get session details
 */
export const getSessionHandler = defineHandler({
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

/**
 * POST /sessions - Create a new session
 */
export const createSessionHandler = defineHandler({
  async execute(
    ctx: PluginContextV3,
    input: RestInput<CreateSessionRequest>
  ): Promise<CreateSessionResponse> {
    try {
      const body = input.body as CreateSessionRequest | undefined;

      if (!body?.agentId) {
        throw new Error('Agent ID is required');
      }

      if (!globalAgentRegistry.has(body.agentId)) {
        throw new PluginError(
          `Agent ID "${body.agentId}" is not defined by the Agents plugin.`,
          'KB_AGENT_NOT_FOUND',
          { agentId: body.agentId },
        );
      }

      const sessionManager = new SessionManager(ctx.cwd);

      const session = await sessionManager.createSession({
        mode: 'execute',
        task: body.task ?? '',
        agentId: body.agentId,
        name: body.name,
      });

      ctx.platform.logger.info(`[sessions-handler] Created session ${session.id} for agent ${body.agentId}`);

      return { session };
    } catch (err) {
      rethrowForRest(err);
    }
  },
});
