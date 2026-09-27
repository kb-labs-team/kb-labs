/**
 * WebSocket handler for session-level event streaming
 *
 * Path: /session/:sessionId
 * Single persistent connection per session — streams turn deltas for ALL runs in the session.
 * Unlike /events/:runId which closes when a run ends, this stays open for the entire session.
 *
 * Delta-based, not read-derived: the session listener registered here receives
 * the exact TurnDelta[] that SessionManager.processEventAndUpdateTurn computed
 * at persist time and published over the platform event bus, not re-derived by
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
} from '@kb-labs/agent-contracts';
import { getAgentsSessionEventTopic, type AgentsSessionEvent } from '@kb-labs/agent-contracts';
import { SessionManager } from '@kb-labs/agent-core';
import { RunManager } from '../rest/run-manager.js';

interface SessionConnectionState {
  sessionId: string;
  unsubscribe: () => void;
  connectedAt: number;
}

/** Backend invocations use fresh contexts, so cleanup is keyed by transport connection ID. */
const connectionState = new Map<string, SessionConnectionState>();

function getConnectionId(ctx: PluginContextV3, sender?: TypedSender<ServerMessage>): string | undefined {
  const hostContext = ctx.hostContext as { connectionId?: string } | undefined;
  return hostContext?.connectionId ?? sender?.getConnectionId();
}

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

      const connectionId = getConnectionId(ctx, sender);
      const connectedAt = Date.now();
      ctx.platform.logger.info('[session-ws] Client connected to session', {
        event: 'agent.session.websocket.connected',
        sessionId,
        connectionId,
        ...(afterSeq != null ? { afterSeq } : {}),
      });

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

      // Subscribe before reading the baseline to avoid losing an event between
      // snapshot creation and subscription. Buffer until the snapshot is sent.
      let snapshotSent = false;
      const pendingEvents: AgentsSessionEvent[] = [];
      const sendSessionEvent = async (payload: AgentsSessionEvent, afterSeq?: number): Promise<void> => {
        if (payload.kind === 'cursor') {
          await sender.send({
            type: 'session:cursor',
            payload: { seq: payload.seq },
            timestamp: Date.now(),
          });
          return;
        }

        if (payload.kind === 'deltas') {
          for (const delta of payload.deltas) {
            if (afterSeq != null && delta.seq <= afterSeq) {
              continue;
            }
            await sender.send({
              type: 'turn:delta',
              payload: { sessionId, delta },
              timestamp: Date.now(),
            } satisfies TurnDeltaMessage).catch((err) => {
              ctx.platform.logger.error('[session-ws] Failed to send turn:delta', err instanceof Error ? err : new Error(String(err)), {
                event: 'agent.session.websocket.send_failed', sessionId, connectionId, messageType: 'turn:delta',
              });
            });
          }
          return;
        }

        await sender.send({
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
          ctx.platform.logger.error('[session-ws] Failed to send run:completed', err instanceof Error ? err : new Error(String(err)), {
            event: 'agent.session.websocket.send_failed', sessionId, connectionId, messageType: 'run:completed', runId: payload.runId,
          });
        });
      };

      const unsubscribe = ctx.platform.eventBus.subscribe<AgentsSessionEvent>(
        getAgentsSessionEventTopic(sessionId),
        async (payload) => {
          if (!snapshotSent) {
            pendingEvents.push(payload);
            return;
          }
          await sendSessionEvent(payload);
        },
      );

      try {
        await unsubscribe.ready;
        const { turns: projectionTurns, seq } = await sessionManager.getProjection(sessionId);
        const turns = await RunManager.reconcileSessionTurns(sessionManager, sessionId, projectionTurns);
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
        snapshotSent = true;
        for (const pending of pendingEvents.splice(0)) {
          if (pending.kind === 'deltas') {
            if (pending.deltas.some((delta) => delta.seq > seq)) {
              await sendSessionEvent(pending, seq);
            }
          } else if (pending.seq > seq) {
            await sendSessionEvent(pending, seq);
          }
        }
        if (connectionId) {
          connectionState.set(connectionId, { sessionId, unsubscribe, connectedAt });
        } else {
          unsubscribe();
        }
        ctx.platform.logger.info('[session-ws] Session event subscription registered', {
          event: 'agent.session.websocket.subscribed',
          sessionId,
          connectionId,
          completedTurns: completedTurns.length,
          activeTurns: activeTurns.length,
          seq,
        });
      } catch (error) {
        unsubscribe();
        ctx.platform.logger.error('[session-ws] Failed to send conversation snapshot', error instanceof Error ? error : new Error(String(error)), {
          event: 'agent.session.websocket.snapshot_failed', sessionId, connectionId,
        });
        throw error;
      }
    },

    async onMessage(ctx: PluginContextV3, message: ClientMessage, sender: TypedSender<ServerMessage>) {
      // Handle ping or corrections here if needed
      if (message.type === 'ping') {
        const sessionId = connectionState.get(getConnectionId(ctx, sender) ?? '')?.sessionId ?? '';
        await sender.send({
          type: 'connection:ready',
          payload: { runId: sessionId ?? '', connectedAt: new Date().toISOString() },
          timestamp: Date.now(),
        });
      }
    },

    async onDisconnect(ctx: PluginContextV3, code: number, reason: string) {
      const connectionId = getConnectionId(ctx);
      const state = connectionId ? connectionState.get(connectionId) : undefined;
      if (state) {
        state.unsubscribe();
        connectionState.delete(connectionId!);
      }

      ctx.platform.logger.info('[session-ws] Client disconnected from session', {
        event: 'agent.session.websocket.disconnected',
        sessionId: state?.sessionId,
        connectionId,
        closeCode: code,
        closeReason: reason,
        durationMs: state ? Date.now() - state.connectedAt : undefined,
        subscriptionFound: Boolean(state),
      });
    },

    async onError(ctx: PluginContextV3, error: Error, sender: TypedSender<ServerMessage>) {
      ctx.platform.logger.error('[session-ws] WebSocket error', error, {
        event: 'agent.session.websocket.error',
        connectionId: getConnectionId(ctx, sender),
        sessionId: (ctx.hostContext as { params?: { sessionId?: string } } | undefined)?.params?.sessionId,
      });
      await sender.send({
        type: 'error',
        payload: { code: 'INTERNAL_ERROR', message: error.message },
        timestamp: Date.now(),
      } satisfies ErrorMessage);
    },
  },
});
