/**
 * @module @kb-labs/plugin-execution/ws/channel-mounter
 *
 * Mount plugin WebSocket channels to Fastify server.
 * Follows the same pattern as route-mounter but for WebSocket channels.
 */

import type { FastifyInstance, FastifyPluginCallback, RouteShorthandOptions } from 'fastify';
import fastifyWebsocket, { type WebsocketHandler, type WebsocketPluginOptions } from '@fastify/websocket';
import type {
  ManifestV3,
  PluginContextDescriptor,
  WebSocketHostContext,
  WSInput,
} from '@kb-labs/plugin-contracts';
import { DEFAULT_PERMISSIONS } from '@kb-labs/plugin-contracts';
import type { ExecutionBackend } from '../types.js';
import { connectionRegistry } from './connection-registry.js';
import { createWSSender } from './sender.js';

// Import utility functions (assuming they exist in utils.ts)
// If these don't exist, we'll need to create them or use alternatives
let createExecutionId: () => string;
let normalizeHeaders: (headers: Record<string, any>) => Record<string, string>;

try {
  const utils = await import('../utils.js');
  createExecutionId = utils.createExecutionId;
  normalizeHeaders = utils.normalizeHeaders;
} catch {
  // Fallback implementations if utils don't exist
  createExecutionId = () => `exec_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  normalizeHeaders = (headers) => {
    const normalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      normalized[key.toLowerCase()] = String(value);
    }
    return normalized;
  };
}

export interface MountWebSocketChannelsOptions {
  /** Execution backend */
  backend: ExecutionBackend;

  /** Plugin root directory */
  pluginRoot: string;

  /** Workspace root directory */
  workspaceRoot: string;

  /** Base path prefix (optional, defaults to /v1/ws/plugins/{manifest.id}) */
  basePath?: string;

  /** Default timeout in ms (optional, default: 300000 = 5 minutes) */
  defaultTimeoutMs?: number;

  /** Default max message size in bytes (optional, default: 1MB) */
  defaultMaxMessageSize?: number;
}

/**
 * Mount plugin WebSocket channels to Fastify server.
 *
 * @param server - Fastify server instance
 * @param manifest - Plugin manifest
 * @param options - Mounting options
 * @returns Result with mounted count and errors
 */
export async function mountWebSocketChannels(
  server: FastifyInstance,
  manifest: ManifestV3,
  options: MountWebSocketChannelsOptions
): Promise<{ mounted: number; errors: string[] }> {
  const errors: string[] = [];
  let mounted = 0;

  const channels = manifest.ws?.channels ?? [];

  if (channels.length === 0) {
    return { mounted, errors };
  }

  // Register WebSocket plugin if not already registered
  if (!server.hasPlugin('@fastify/websocket')) {
    try {
      await server.register(fastifyWebsocket as FastifyPluginCallback<WebsocketPluginOptions>);
    } catch (error) {
      errors.push(`Failed to register WebSocket plugin: ${error instanceof Error ? error.message : String(error)}`);
      return { mounted, errors };
    }
  }

  const basePath = options.basePath || `/v1/ws/plugins/${manifest.id}`;

  for (const channel of channels) {
    try {
      const fullPath = `${basePath}${channel.path}`;

      // Register WebSocket route
      const handler: WebsocketHandler = async (socket, request) => {
        const ws = socket;
        const connectionId = createExecutionId();

        // Extract IDs for tracing
        const requestId = (typeof request.headers['x-request-id'] === 'string' ? request.headers['x-request-id'] : undefined) || createExecutionId();
        const traceId = (typeof request.headers['x-trace-id'] === 'string' ? request.headers['x-trace-id'] : undefined) || createExecutionId();
        const tenantId = typeof request.headers['x-tenant-id'] === 'string' ? request.headers['x-tenant-id'] : undefined;
        const connectionLogger = server.log.child({
          pluginId: manifest.id,
          requestId,
          traceId,
          tenantId,
          'network.transport': 'websocket',
          'network.connection_id': connectionId,
          'websocket.channel': channel.path,
        });
        const transportStats = {
          inboundMessages: 0,
          inboundBytes: 0,
          outboundMessages: 0,
          outboundBytes: 0,
          droppedMessages: 0,
          handlerErrors: 0,
        };
        const connectedAt = Date.now();
        const handlerTimeoutMs = channel.timeoutMs ?? options.defaultTimeoutMs;
        const maxMessageSize = channel.maxMessageSize ?? options.defaultMaxMessageSize;
        const idleTimeoutMs = channel.idleTimeoutMs ?? manifest.ws?.defaults?.idleTimeoutMs;
        let idleTimer: NodeJS.Timeout | undefined;
        const resetIdleTimer = () => {
          if (!idleTimeoutMs || idleTimeoutMs <= 0) { return; }
          if (idleTimer) { clearTimeout(idleTimer); }
          idleTimer = setTimeout(() => {
            connectionLogger.info({
              event: 'websocket.connection.idle_timeout',
              idleTimeoutMs,
            }, '[ws] idle connection closed');
            ws.close(1001, 'Idle timeout');
          }, idleTimeoutMs);
        };

        // Register connection
        connectionRegistry.register({
          connectionId,
          channelPath: channel.path,
          socket: ws,
          tenantId,
          metadata: {},
        });

        // Create sender interface
        const sender = createWSSender(ws, connectionId, channel.path, {
          logger: connectionLogger,
          stats: transportStats,
        });

        // Build WebSocketHostContext
        const hostContext: WebSocketHostContext = {
          host: 'ws',
          channelPath: channel.path,
          connectionId,
          clientIp: request.ip,
          headers: normalizeHeaders(request.headers),
          query: request.query as Record<string, string> | undefined,
          params: request.params as Record<string, string> | undefined,
          requestId,
          traceId,
          tenantId,
          // TODO: Extract user from auth token if auth is enabled
        };

        const descriptor: PluginContextDescriptor = {
          hostType: 'ws',
          pluginId: manifest.id,
          pluginVersion: manifest.version,
          requestId,
          permissions: channel.permissions || manifest.permissions || DEFAULT_PERMISSIONS,
          hostContext,
        };
        Object.assign(descriptor as unknown as Record<string, unknown>, { traceId });

        const executeChannelHandler = async (input: WSInput, timeoutMs?: number): Promise<void> => {
          const executionId = createExecutionId();
          const result = await options.backend.execute({
            executionId,
            descriptor: Object.assign({ ...descriptor }, {
              executionId,
              spanId: executionId,
              invocationId: executionId,
            }) as PluginContextDescriptor,
            pluginRoot: options.pluginRoot,
            handlerRef: channel.handler,
            input,
            workspace: {
              type: 'local',
              cwd: options.workspaceRoot,
            },
            timeoutMs: timeoutMs ?? handlerTimeoutMs,
          });
          // Propagate backend errors so onConnect catch block can close the socket
          if (!result.ok) {
            throw new Error(result.error?.message ?? 'Handler execution failed');
          }
        };

        // Buffer messages that arrive while onConnect is still executing.
        // Client-side WS goes 'open' as soon as the upgrade handshake completes
        // — but onConnect can take tens of ms (esp. via IPC backend). Without
        // this guard, the first message a fast client sends is dropped, which
        // is the root cause of the e2e-workflows ws subscribe-timeout flakes.
        let connectReady = false;
        const pendingMessages: Buffer[] = [];

        const processMessage = async (data: Buffer): Promise<void> => {
          try {
            if (maxMessageSize && data.byteLength > maxMessageSize) {
              connectionLogger.warn({
                event: 'websocket.message.rejected',
                reason: 'max_message_size_exceeded',
                payloadBytes: data.byteLength,
                maxMessageSize,
              }, '[ws] message rejected: too large');
              ws.close(1009, 'Message too large');
              return;
            }
            resetIdleTimer();
            const rawMessage = JSON.parse(data.toString());
            transportStats.inboundMessages += 1;
            transportStats.inboundBytes += data.byteLength;
            connectionLogger.info(
              {
                event: 'websocket.message.received',
                'messaging.direction': 'inbound',
                'messaging.message_type': rawMessage?.type,
                'messaging.message_id': rawMessage?.messageId,
                payloadBytes: data.byteLength,
              },
              `[ws] message received — type=${rawMessage?.type}`
            );
            let payload = rawMessage.payload;
            if (payload === undefined) {
              const { type: _t, messageId: _mid, timestamp: _ts, ...rest } = rawMessage;
              if (Object.keys(rest).length > 0) { payload = rest; }
            }
            const messageInput: WSInput = {
              event: 'message',
              message: {
                type: rawMessage.type,
                payload,
                messageId: rawMessage.messageId,
                timestamp: rawMessage.timestamp || Date.now(),
              },
              sender,
            };
            const t0 = Date.now();
            await executeChannelHandler(messageInput);
            connectionLogger.info(
              { event: 'websocket.handler.completed', durationMs: Date.now() - t0 },
              `[ws] message handler completed`
            );
          } catch (error) {
            transportStats.handlerErrors += 1;
            const errMessage = error instanceof Error ? error.message : String(error);
            const errStack = error instanceof Error ? error.stack : undefined;
            connectionLogger.error(
              {
                err: error,
                errorMessage: errMessage,
                errorStack: errStack,
                plugin: manifest.id,
                channel: channel.path,
                connectionId,
              },
              `[ws] onMessage failed — plugin "${manifest.id}", channel "${channel.path}": ${errMessage}`
            );
            const errorInput: WSInput = {
              event: 'error',
              error: error as Error,
              sender,
            };
            try {
              await executeChannelHandler(errorInput);
            } catch (err) {
              connectionLogger.error(
                { err, plugin: manifest.id, channel: channel.path, connectionId },
                `[ws] onError handler also failed — plugin "${manifest.id}", channel "${channel.path}"`
              );
            }
          }
        };

        // Attach the 'message' listener BEFORE awaiting onConnect so messages
        // sent by an eager client are not dropped. Anything received before
        // connectReady=true is buffered and dispatched in order after onConnect
        // resolves.
        ws.on('message', (data: Buffer) => {
          if (!connectReady) {
            pendingMessages.push(data);
            return;
          }
          void processMessage(data);
        });

        // Call onConnect lifecycle
        try {
          const connectInput: WSInput = { event: 'connect', sender };
          const connectedHandlerAt = Date.now();
          await executeChannelHandler(connectInput);
          resetIdleTimer();
          connectionLogger.info({
            event: 'websocket.connection.opened',
            connectDurationMs: Date.now() - connectedHandlerAt,
          }, '[ws] connection opened');
        } catch (error) {
          const errMessage = error instanceof Error ? error.message : String(error);
          const errStack = error instanceof Error ? error.stack : undefined;
          connectionLogger.error(
            {
              err: error,
              errorMessage: errMessage,
              errorStack: errStack,
              plugin: manifest.id,
              channel: channel.path,
              connectionId,
            },
            `[ws] onConnect failed — plugin "${manifest.id}", channel "${channel.path}": ${errMessage}`
          );
          ws.close(1011, 'Handler error');
          connectionRegistry.unregister(connectionId);
          return;
        }

        // Drain any messages buffered during onConnect, then mark ready so
        // subsequent messages go straight to processMessage.
        connectReady = true;
        for (const buffered of pendingMessages) {
          void processMessage(buffered);
        }
        pendingMessages.length = 0;

        // Handle disconnect
        ws.on('close', async (code: number, reason: Buffer) => {
          if (idleTimer) { clearTimeout(idleTimer); }
          connectionRegistry.unregister(connectionId);

          try {
            const disconnectInput: WSInput = {
              event: 'disconnect',
              disconnectCode: code,
              disconnectReason: reason.toString(),
            };
            await executeChannelHandler(disconnectInput);
          } catch (error) {
            transportStats.handlerErrors += 1;
            connectionLogger.error(
              { err: error, plugin: manifest.id, channel: channel.path, connectionId, code },
              `[ws] onDisconnect failed — plugin "${manifest.id}", channel "${channel.path}"`
            );
          } finally {
            connectionLogger.info({
              event: 'websocket.connection.closed',
              closeCode: code,
              closeReason: reason.toString(),
              durationMs: Date.now() - connectedAt,
              ...transportStats,
            }, '[ws] connection closed');
          }
        });

        // Handle errors
        ws.on('error', async (error: Error) => {
          try {
            const errorInput: WSInput = {
              event: 'error',
              error,
              sender,
            };
            await executeChannelHandler(errorInput);
          } catch (err) {
            transportStats.handlerErrors += 1;
            connectionLogger.error(
              { err, plugin: manifest.id, channel: channel.path, connectionId },
              `[ws] onError handler failed — plugin "${manifest.id}", channel "${channel.path}"`
            );
          }
        });
      };

      // @fastify/websocket extends RouteShorthandOptions with { websocket?: boolean } via module
      // augmentation. tsup DTS generation does not see that augmentation, so we cast to the
      // concrete options type here instead of relying on the merged declaration.
      server.get(
        fullPath,
        { websocket: true } as RouteShorthandOptions & { websocket: true },
        handler as WebsocketHandler,
      );

      mounted++;
      server.log.info({ plugin: manifest.id, channel: channel.path, fullPath }, `[ws] Mounted WebSocket channel: ${fullPath}`);
    } catch (error) {
      const errorMsg = `[ws] Failed to mount channel "${channel.path}" (plugin: ${manifest.id}): ${error instanceof Error ? error.message : String(error)}`;
      errors.push(errorMsg);
      server.log.error({ err: error, plugin: manifest.id, channel: channel.path }, errorMsg);
    }
  }

  return { mounted, errors };
}
