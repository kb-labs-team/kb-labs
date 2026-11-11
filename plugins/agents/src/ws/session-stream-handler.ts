/**
 * WebSocket handler for session-level event streaming
 *
 * Path: /session/:sessionId
 * Single persistent connection per session — streams turn deltas for ALL runs in the session.
 * Unlike /events/:runId which closes when a run ends, this stays open for the entire session.
 *
 * Delta-based, not read-derived: the session listener registered here receives
 * the exact TurnDelta[] that SessionManager.processEventAndUpdateTurn computed
 * at persist time (via RunManager.broadcastSessionDeltas), not re-derived by
 * re-reading turns.json off disk on every event. That re-read (the previous
 * resolveTurnForEvent) was the actual root cause of the WS stream lagging one
 * event behind persisted state — see run-handler.ts's onEvent for the other
 * half of that fix (persist now happens before broadcast, not after).
 */

import {
  defineWebSocket,
  type PluginContextV3,
  type TypedSender,
} from '@kb-labs/sdk';
import type {
  ServerMessage,
  ClientMessage,
  ConnectionReadyMessage,
  RunCompletedMessage,
  ErrorMessage,
  TurnDeltaMessage,
  ConversationSnapshotMessage,
} from '../contracts/index.js';
import { RunManager, type SessionBroadcastPayload } from '../rest/run-manager.js';
import { SessionManager } from '../core/index.js';

interface SessionConnectionState {
  sessionId: string;
  callback: (payload: SessionBroadcastPayload) => void;
}

/** Per-connection state keyed by the opaque ctx object — avoids mutating ctx */
const connectionState = new WeakMap<object, SessionConnectionState>();

export default defineWebSocket<unknown, ClientMessage, ServerMessage>({
  path: '/session/:sessionId',
  description: 'Persistent session event stream (all runs)',

  handler: {
    async onConnect(ctx: PluginContextV3, sender: TypedSender<ServerMessage>) {
      const hostContext = ctx.hostContext as { params?: { sessionId?: string }; query?: Record<string, string> };
      const sessionId = hostContext.params?.sessionId;
      // Present on resume/gap-recovery reconnects (see AgentsPage.tsx's turn-reducer
      // 'gap' handling). Not used to filter the response — see getProjection's doc
      // comment for why resume always re-sends the full projection rather than a
      // replayed delta range — but accepted and logged so a resume is distinguishable
      // from a cold connect in server logs.
      const afterSeq = hostContext.query?.afterSeq ? Number(hostContext.query.afterSeq) : undefined;

      if (!sessionId) {
        await sender.send({
          type: 'error',
          payload: { code: 'MISSING_SESSION_ID', message: 'Session ID is required' },
          timestamp: Date.now(),
        } satisfies ErrorMessage);
        sender.close(4000, 'Missing session ID');
        return;
      }

      ctx.platform.logger.info(
        afterSeq != null
          ? `[session-ws] Client connected to session ${sessionId} (resume after seq ${afterSeq})`
          : `[session-ws] Client connected to session ${sessionId}`
      );

      const sessionManager = new SessionManager(ctx.cwd);

      // Send connection:ready immediately
      try {
        await sender.send({
          type: 'connection:ready',
          payload: { runId: sessionId, connectedAt: new Date().toISOString() },
          timestamp: Date.now(),
        } satisfies ConnectionReadyMessage);
      } catch (err) {
        ctx.platform.logger.error(`[session-ws] Failed to send connection:ready: ${String(err)}`);
        throw err;
      }

      // Send conversation:snapshot (full current projection) as the baseline —
      // both for a cold connect AND a resume/gap-recovery reconnect alike.
      try {
        const { turns, seq } = await sessionManager.getProjection(sessionId);
        const completedTurns = turns.filter((t) => t.status !== 'streaming');
        const activeTurns = turns.filter((t) => t.status === 'streaming');
        await sender.send({
          type: 'conversation:snapshot',
          payload: {
            sessionId,
            completedTurns,
            activeTurns,
            totalTurns: turns.length,
            seq,
            timestamp: new Date().toISOString(),
          },
          timestamp: Date.now(),
        } satisfies ConversationSnapshotMessage);
        ctx.platform.logger.info(
          `[session-ws] Sent snapshot: ${completedTurns.length} completed + ${activeTurns.length} active turns at seq ${seq}`
        );
      } catch (err) {
        ctx.platform.logger.error(`[session-ws] Failed to send snapshot: ${err}`);
      }

      // Session-level listener — receives turn deltas and run:completed
      // notifications from ALL runs in this session, already computed at
      // persist time (see module doc comment above).
      const callback = (payload: SessionBroadcastPayload) => {
        if (payload.kind === 'deltas') {
          for (const delta of payload.deltas) {
            void sender.send({
              type: 'turn:delta',
              payload: { sessionId, delta },
              timestamp: Date.now(),
            } satisfies TurnDeltaMessage).catch((err) => {
              ctx.platform.logger.error(`[session-ws] Failed to send turn:delta: ${err}`);
            });
          }
          return;
        }

        void sender.send({
          type: 'run:completed',
          payload: {
            runId: payload.runId,
            success: payload.success,
            summary: payload.summary,
            durationMs: payload.durationMs,
            seq: payload.seq,
            turn: payload.turn,
          },
          timestamp: Date.now(),
        } satisfies RunCompletedMessage).catch((err) => {
          ctx.platform.logger.error(`[session-ws] Failed to send run:completed: ${err}`);
        });
      };

      // Store callback for cleanup in a WeakMap keyed by ctx — no ctx mutation
      connectionState.set(ctx as object, { sessionId, callback });

      try {
        RunManager.addSessionListener(sessionId, callback);
      } catch (err) {
        ctx.platform.logger.error(`[session-ws] Failed to register session listener: ${String(err)}`);
        throw err;
      }
      ctx.platform.logger.info(`[session-ws] Session listener registered for session ${sessionId}`);
    },

    async onMessage(ctx: PluginContextV3, message: ClientMessage, sender: TypedSender<ServerMessage>) {
      // Handle ping or corrections here if needed
      if (message.type === 'ping') {
        const sessionId = connectionState.get(ctx as object)?.sessionId ?? '';
        await sender.send({
          type: 'connection:ready',
          payload: { runId: sessionId ?? '', connectedAt: new Date().toISOString() },
          timestamp: Date.now(),
        });
      }
    },

    async onDisconnect(ctx: PluginContextV3) {
      const state = connectionState.get(ctx as object);
      if (state) {
        RunManager.removeSessionListener(state.sessionId, state.callback);
        connectionState.delete(ctx as object);
      }

      ctx.platform.logger.info(`[session-ws] Client disconnected from session ${state?.sessionId}`);
    },

    async onError(ctx: PluginContextV3, error: Error, sender: TypedSender<ServerMessage>) {
      ctx.platform.logger.error(`[session-ws] WebSocket error: ${error.message}`);
      await sender.send({
        type: 'error',
        payload: { code: 'INTERNAL_ERROR', message: error.message },
        timestamp: Date.now(),
      } satisfies ErrorMessage);
    },
  },
});
