/**
 * WSSender implementation
 *
 * Provides the WSSender interface implementation for WebSocket handlers.
 */

import type { WebSocket } from 'ws';
import type { WSSender, WSMessage } from '@kb-labs/plugin-contracts';
import { connectionRegistry } from './connection-registry.js';

export interface WebSocketTransportStats {
  outboundMessages: number;
  outboundBytes: number;
  droppedMessages: number;
}

interface WebSocketTelemetryLogger {
  info(fields: Record<string, unknown>, message?: string): void;
  warn(fields: Record<string, unknown>, message?: string): void;
}

/**
 * Create WSSender instance for a WebSocket connection
 *
 * @param ws - WebSocket instance
 * @param connectionId - Unique connection ID
 * @param channelPath - Channel path (e.g., "/live")
 */
export function createWSSender(
  ws: WebSocket,
  connectionId: string,
  channelPath: string,
  telemetry?: { logger: WebSocketTelemetryLogger; stats: WebSocketTransportStats },
): WSSender {
  const pendingMessages: Array<{ payload: string; message: WSMessage }> = [];
  let openListenerAttached = false;

  const recordSent = (payload: string, message: WSMessage) => {
    ws.send(payload);
    if (telemetry) {
      telemetry.stats.outboundMessages += 1;
      telemetry.stats.outboundBytes += Buffer.byteLength(payload);
      telemetry.logger.info({
        event: 'websocket.message.sent',
        'messaging.direction': 'outbound',
        'messaging.message_type': message.type,
        'messaging.message_id': message.messageId,
        payloadBytes: Buffer.byteLength(payload),
      }, '[ws] message sent');
    }
  };

  const flushPending = () => {
    if (ws.readyState !== 1) { return; }
    openListenerAttached = false;
    while (pendingMessages.length > 0 && ws.readyState === 1) {
      const pending = pendingMessages.shift()!;
      recordSent(pending.payload, pending.message);
    }
  };

  const dropPending = () => {
    while (pendingMessages.length > 0) {
      const { message } = pendingMessages.shift()!;
      if (telemetry) {
        telemetry.stats.droppedMessages += 1;
        telemetry.logger.warn({
          event: 'websocket.message.dropped',
          'messaging.direction': 'outbound',
          'messaging.message_type': message.type,
          reason: 'socket_closed_before_open',
        }, '[ws] queued message dropped after socket closed');
      }
    }
  };

  return {
    async send(message: WSMessage) {
      const payload = JSON.stringify(message);
      if (ws.readyState === 1) {
        recordSent(payload, message);
      } else if (ws.readyState === 0) {
        pendingMessages.push({ payload, message });
        if (!openListenerAttached) {
          openListenerAttached = true;
          ws.once('open', flushPending);
          ws.once('close', dropPending);
        }
        // Recheck in case the handshake completed while listeners were attached.
        flushPending();
        telemetry?.logger.info({
          event: 'websocket.message.queued',
          'messaging.direction': 'outbound',
          'messaging.message_type': message.type,
          queueDepth: pendingMessages.length,
        }, '[ws] message queued until socket opens');
      } else if (telemetry) {
        telemetry.stats.droppedMessages += 1;
        // A peer closing while async handler work is still finishing is a normal
        // WebSocket lifecycle race. Keep it observable without raising a user-facing
        // warning for every send attempted after disconnect.
        telemetry.logger.info({
          event: 'websocket.message.dropped',
          'messaging.direction': 'outbound',
          'messaging.message_type': message.type,
          reason: ws.readyState === 2 ? 'socket_closing' : 'socket_closed',
        }, '[ws] message skipped after connection closed');
      }
    },

    async broadcast(message: WSMessage, excludeSelf = true) {
      const result = connectionRegistry.broadcast(
        channelPath,
        message,
        excludeSelf ? connectionId : undefined
      ) ?? { sent: 0, dropped: 0 };
      telemetry?.logger.info({
        event: 'websocket.broadcast.sent',
        'messaging.direction': 'outbound',
        'messaging.message_type': message.type,
        recipients: result.sent,
        droppedRecipients: result.dropped,
      }, '[ws] broadcast sent');
    },

    async sendTo(connectionIds: string[], message: WSMessage) {
      const result = connectionRegistry.sendTo(connectionIds, message) ?? { sent: 0, dropped: 0 };
      telemetry?.logger.info({
        event: 'websocket.message.sent_to',
        'messaging.direction': 'outbound',
        'messaging.message_type': message.type,
        recipients: result.sent,
        droppedRecipients: result.dropped,
      }, '[ws] targeted messages sent');
    },

    close(code?: number, reason?: string) {
      ws.close(code || 1000, reason);
    },

    getConnectionId() {
      return connectionId;
    },
  };
}
