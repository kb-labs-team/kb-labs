import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';

interface WsRequest {
  headers: { authorization?: string };
  url?: string;
}
import { logDiagnosticEvent, type ICache, type ILogger } from '@kb-labs/core-platform';
import {
  HelloMessageSchema,
  AdapterCallMessageSchema,
  AdapterNameSchema,
  HostCapabilitySchema,
  SUPPORTED_PROTOCOL_VERSIONS,
  type HostCapability,
  type OutboundMessage,
} from '@kb-labs/gateway-contracts';
import { AdaptiveBuffer } from '@kb-labs/gateway-core';
import { getClientByHostId, type JwtConfig } from '@kb-labs/gateway-auth';
import { HostRegistry } from './registry.js';
import { extractBearerToken, resolveToken } from '../auth/tokens.js';
import { globalDispatcher } from './dispatcher.js';
import { executionRegistry } from '../execute/execution-registry.js';

const HELLO_TIMEOUT_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_GRACE_MS = 10_000;

function send(ws: WebSocket, msg: OutboundMessage): void {
  ws.send(JSON.stringify(msg));
}

export function createWsHandler(
  cache: ICache,
  jwtConfig: JwtConfig,
  logger: ILogger,
  hostRegistry?: HostRegistry,
) {
  const registry = hostRegistry ?? new HostRegistry(cache);
  const buffer = new AdaptiveBuffer(cache);

  return async function wsHandler(
    socket: WebSocket,
    request: WsRequest,
  ): Promise<void> {
    // 1. Auth — machine token required
    const token = extractBearerToken(request.headers.authorization);
    if (!token) {
      logDiagnosticEvent(logger, {
        domain: 'service',
        event: 'gateway.hosts.ws.auth',
        level: 'warn',
        reasonCode: 'websocket_auth_failed',
        message: 'Host WebSocket connection missing authorization token',
        outcome: 'failed',
        serviceId: 'gateway',
        route: '/hosts/connect',
      });
      socket.close(1008, 'Missing Authorization header');
      return;
    }

    // 2. Start buffering hello BEFORE async auth to prevent race condition.
    // Client may send hello during await resolveToken — capture it immediately.
    let resolveHello!: (raw: Buffer) => void;
    let rejectHello!: (err: Error) => void;
    const helloRawPromise = new Promise<Buffer>((res, rej) => {
      resolveHello = res;
      rejectHello = rej;
    });
    // Consume rejection so early-return paths (e.g. token rejected before the
    // socket.once('close') listener fires) don't leak an unhandledRejection,
    // which BulkTransferHelper's process-wide uncaughtException handler would
    // escalate into process.exit(1), killing the gateway.
    helloRawPromise.catch(() => { /* awaited below or intentionally discarded */ });
    const helloTimeout = setTimeout(() => {
      socket.close(1008, 'Hello timeout');
      rejectHello(new Error('Hello timeout'));
    }, HELLO_TIMEOUT_MS);
    socket.once('message', (raw) => {
      clearTimeout(helloTimeout);
      resolveHello(raw as Buffer);
    });
    socket.once('close', () => {
      clearTimeout(helloTimeout);
      rejectHello(new Error('Socket closed before hello'));
    });

    const tokenEntry = await resolveToken(token, cache, jwtConfig);
    if (!tokenEntry.ok || tokenEntry.payload.type !== 'machine') {
      clearTimeout(helloTimeout);
      logDiagnosticEvent(logger, {
        domain: 'service',
        event: 'gateway.hosts.ws.auth',
        level: 'warn',
        reasonCode: tokenEntry.ok ? 'wrong_token_kind' : `token_${tokenEntry.reason}`,
        message: 'Host WebSocket machine token rejected',
        outcome: 'failed',
        serviceId: 'gateway',
        route: '/hosts/connect',
      });
      socket.close(1008, 'Invalid machine token');
      return;
    }

    const { userId: hostId, namespaceId } = tokenEntry.payload;
    const connectionId = randomUUID();
    const sessionId = randomUUID();

    // 3. Process buffered hello (may already be resolved if client was fast)
    let protocolVersion: string | null = null;
    let helloCaps: string[] = [];

    const protocolVersions: readonly string[] = SUPPORTED_PROTOCOL_VERSIONS;

    try {
      const helloRaw = await helloRawPromise;
      const msg = HelloMessageSchema.parse(JSON.parse(helloRaw.toString()));

      if (!protocolVersions.includes(msg.protocolVersion)) {
        logDiagnosticEvent(logger, {
          domain: 'service',
          event: 'gateway.hosts.ws.handshake',
          level: 'warn',
          reasonCode: 'websocket_protocol_unsupported',
          message: 'Host WebSocket protocol version is unsupported',
          outcome: 'failed',
          serviceId: 'gateway',
          route: '/hosts/connect',
          evidence: {
            hostId,
            namespaceId,
            protocolVersion: msg.protocolVersion,
            supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
          },
        });
        send(socket, {
          type: 'negotiate',
          supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
        });
        socket.close(1008, 'Unsupported protocol version');
        return;
      }

      protocolVersion = msg.protocolVersion;
      helloCaps = msg.capabilities ?? [];
    } catch (error) {
      const isTimeout = error instanceof Error && error.message === 'Hello timeout';
      if (isTimeout) {
        logDiagnosticEvent(logger, {
          domain: 'service',
          event: 'gateway.hosts.ws.handshake',
          level: 'warn',
          reasonCode: 'websocket_hello_timeout',
          message: 'Host WebSocket hello timed out',
          outcome: 'failed',
          serviceId: 'gateway',
          route: '/hosts/connect',
          evidence: { hostId, namespaceId },
        });
      } else if (!(error instanceof Error && error.message === 'Socket closed before hello')) {
        logDiagnosticEvent(logger, {
          domain: 'service',
          event: 'gateway.hosts.ws.handshake',
          level: 'warn',
          reasonCode: 'websocket_handshake_invalid',
          message: 'Host WebSocket hello message is invalid',
          outcome: 'failed',
          error: error instanceof Error ? error : new Error(String(error)),
          serviceId: 'gateway',
          route: '/hosts/connect',
          evidence: { hostId, namespaceId },
        });
        socket.close(1008, 'Invalid hello message');
      }
      return;
    }

    if (!protocolVersion) {return;}

    // 3. Resolve capabilities for dispatcher routing.
    //
    // Priority order:
    //   1. AuthStore clientRecord (JWT-registered via /auth/register) — authoritative
    //   2. HostRegistry descriptor (registered via /hosts/register) — authoritative
    //   3. Hello-message capabilities (static/dev tokens with no registry entry) — validated
    const clientRecord = await getClientByHostId(cache, hostId);
    const registryCaps: HostCapability[] = (clientRecord?.capabilities ?? []).flatMap((c) => {
      const r = HostCapabilitySchema.safeParse(c);
      return r.success ? [r.data] : [];
    });

    let capabilities: HostCapability[];
    if (clientRecord) {
      // JWT-registered host: use AuthStore capabilities only
      capabilities = registryCaps;
    } else {
      // Check HostRegistry for machine-token-registered hosts (/hosts/register)
      let existingDescriptor = null;
      try {
        existingDescriptor = await registry.get(hostId, namespaceId);
      } catch (err) {
        logDiagnosticEvent(logger, {
          domain: 'service',
          event: 'gateway.hosts.ws.handshake',
          level: 'warn',
          reasonCode: 'registry_lookup_failed',
          message: 'Failed to look up host descriptor from registry, falling back to hello capabilities',
          outcome: 'failed',
          error: err instanceof Error ? err : new Error(String(err)),
          serviceId: 'gateway',
          route: '/hosts/connect',
          evidence: { hostId, namespaceId },
        });
      }
      if (existingDescriptor && existingDescriptor.capabilities.length > 0) {
        capabilities = existingDescriptor.capabilities.flatMap((c) => {
          const r = HostCapabilitySchema.safeParse(c);
          return r.success ? [r.data] : [];
        });
      } else {
        // Static/dev token with no registry entry: accept validated hello capabilities
        capabilities = helloCaps.flatMap((c) => {
          const r = HostCapabilitySchema.safeParse(c);
          return r.success ? [r.data] : [];
        });
      }
    }

    await registry.ensureRegistered(hostId, namespaceId, clientRecord?.name ?? hostId, capabilities);

    // 4. Set online + register in dispatcher (with capabilities for routing) + send connected
    await registry.setOnline(hostId, namespaceId, connectionId);
    globalDispatcher.registerConnection(hostId, namespaceId, socket, capabilities);

    // 5. Heartbeat watchdog
    let lastHeartbeat = Date.now();
    const heartbeatWatchdog = setInterval(async () => {
      const elapsed = Date.now() - lastHeartbeat;
      if (elapsed > HEARTBEAT_INTERVAL_MS + HEARTBEAT_GRACE_MS) {
        // Mark as degraded (don't close — allow recovery)
        const host = await registry.get(hostId, namespaceId);
        if (host && host.status !== 'degraded') {
          await cache.set(`host:registry:${namespaceId}:${hostId}`, {
            ...host,
            status: 'degraded',
          });
        }
      }
    }, HEARTBEAT_INTERVAL_MS);

    // 6. Message handler
    socket.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type: string; requestId?: string };

        switch (msg.type) {
          case 'heartbeat':
            lastHeartbeat = Date.now();
            await registry.heartbeat(hostId, namespaceId);
            send(socket, { type: 'ack' });
            break;

          case 'chunk':
          case 'result':
          case 'error':
            globalDispatcher.handleInbound(msg as { type: string; requestId?: string; data?: unknown; error?: unknown });
            break;

          case 'adapter:call':
            void handleAdapterCall(msg, socket, hostId, namespaceId);
            break;
        }
      } catch (error) {
        logDiagnosticEvent(logger, {
          domain: 'service',
          event: 'gateway.hosts.ws.message',
          level: 'warn',
          reasonCode: 'websocket_message_invalid',
          message: 'Host WebSocket message is malformed',
          outcome: 'failed',
          error: error instanceof Error ? error : new Error(String(error)),
          serviceId: 'gateway',
          route: '/hosts/connect',
          evidence: {
            hostId,
            namespaceId,
          },
        });
      }
    });

    // 7. Disconnect cleanup
    socket.on('close', async () => {
      clearInterval(heartbeatWatchdog);
      globalDispatcher.removeConnection(hostId, namespaceId);

      // Cancel all executions dispatched to this host (CC2)
      const cancelled = executionRegistry.cancelByHost(hostId, 'disconnect');
      if (cancelled.length > 0) {
        logDiagnosticEvent(logger, {
          domain: 'service',
          event: 'gateway.hosts.ws.disconnect',
          level: 'warn',
          reasonCode: 'execution_dispatch_failed',
          message: 'Host disconnected and active executions were cancelled',
          outcome: 'failed',
          serviceId: 'gateway',
          route: '/hosts/connect',
          evidence: {
            hostId,
            namespaceId,
            cancelledExecutions: cancelled.length,
          },
        });
      }

      await registry.setOffline(hostId, namespaceId, connectionId);
    });

    // The client may send messages as soon as it receives connected.
    send(socket, {
      type: 'connected',
      protocolVersion,
      hostId,
      sessionId,
    });

    // 4. Flush buffered calls
    const buffered = await buffer.flush(hostId);
    for (const call of buffered) {
      send(socket, {
        type: 'call',
        requestId: call.requestId,
        adapter: call.adapter,
        method: call.method,
        args: call.args,
        trace: { traceId: call.requestId, spanId: randomUUID() },
      });
    }

  };

  /**
   * Handle adapter:call from Host — forward to REST API for platform service execution.
   * Flow: Host → WS adapter:call → Gateway → HTTP POST /api/v1/internal/adapter-call → REST API
   *
   * @see ADR-0051: Bidirectional Gateway Protocol
   */
  async function handleAdapterCall(
    msg: Record<string, unknown>,
    socket: WebSocket,
    hostId: string,
    namespaceId: string,
  ): Promise<void> {
    const requestId = msg['requestId'] as string;

    // 1. Validate message schema
    const parsed = AdapterCallMessageSchema.safeParse(msg);
    if (!parsed.success) {
      logDiagnosticEvent(logger, {
        domain: 'service',
        event: 'gateway.hosts.adapter-call',
        level: 'warn',
        reasonCode: 'websocket_message_invalid',
        message: 'Host adapter call message is invalid',
        outcome: 'failed',
        serviceId: 'gateway',
        route: '/hosts/connect',
        evidence: {
          hostId,
          namespaceId,
          requestId,
        },
      });
      send(socket, {
        type: 'adapter:error',
        requestId: requestId ?? 'unknown',
        error: { code: 'INVALID_MESSAGE', message: parsed.error.message, retryable: false },
      });
      return;
    }

    const call = parsed.data;

    // 2. Validate adapter is in allowlist
    const adapterCheck = AdapterNameSchema.safeParse(call.adapter);
    if (!adapterCheck.success) {
      logDiagnosticEvent(logger, {
        domain: 'service',
        event: 'gateway.hosts.adapter-call',
        level: 'warn',
        reasonCode: 'adapter_call_rejected',
        message: 'Host adapter call rejected by gateway allowlist',
        outcome: 'failed',
        serviceId: 'gateway',
        route: '/hosts/connect',
        evidence: {
          hostId,
          namespaceId,
          requestId: call.requestId,
          adapter: call.adapter,
          method: call.method,
        },
      });
      send(socket, {
        type: 'adapter:error',
        requestId: call.requestId,
        error: { code: 'ADAPTER_CALL_REJECTED', message: `Adapter not allowed: ${call.adapter}`, retryable: false },
      });
      return;
    }

    // 3. Forward to REST API
    const restApiUrl = process.env.REST_API_URL ?? 'http://localhost:5050';
    const internalSecret = process.env.GATEWAY_INTERNAL_SECRET ?? '';

    try {
      const response = await fetch(`${restApiUrl}/api/v1/internal/adapter-call`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-secret': internalSecret,
        },
        body: JSON.stringify({
          requestId: call.requestId,
          adapter: call.adapter,
          method: call.method,
          args: call.args,
          context: {
            ...call.context,
            namespaceId,
            hostId,
          },
        }),
      });

      const body = await response.json() as {
        ok: boolean;
        result?: unknown;
        error?: { code: string; message: string; retryable: boolean; details?: unknown };
      };

      if (body.ok) {
        send(socket, {
          type: 'adapter:response',
          requestId: call.requestId,
          result: body.result,
        });
      } else {
        send(socket, {
          type: 'adapter:error',
          requestId: call.requestId,
          error: body.error ?? { code: 'ADAPTER_ERROR', message: 'Unknown error', retryable: false },
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logDiagnosticEvent(logger, {
        domain: 'service',
        event: 'gateway.hosts.adapter-call',
        level: 'error',
        reasonCode: 'adapter_bridge_unavailable',
        message: 'Gateway could not reach REST adapter bridge',
        outcome: 'failed',
        error: err instanceof Error ? err : new Error(String(err)),
        serviceId: 'gateway',
        route: '/hosts/connect',
        evidence: {
          hostId,
          namespaceId,
          requestId: call.requestId,
          adapter: call.adapter,
          method: call.method,
          restApiUrl,
        },
      });
      send(socket, {
        type: 'adapter:error',
        requestId: call.requestId,
        error: { code: 'ADAPTER_CALL_TIMEOUT', message: `REST API unreachable: ${message}`, retryable: true },
      });
    }
  }
}
