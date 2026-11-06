/**
 * GatewayClient — WebSocket connection to Gateway with:
 * - JWT Bearer auth
 * - hello/connected handshake
 * - heartbeat every 30s
 * - exponential backoff reconnect (1s → 2s → 4s … max 60s)
 * - dispatches incoming `call` messages to registered capability handlers
 */

import { randomUUID } from 'node:crypto';
import { ErrorEnvelopeError, isErrorEnvelope } from '@kb-labs/core-platform';
import { serialize } from '@kb-labs/core-platform/serializable';
import type { ErrorEnvelope } from '@kb-labs/core-platform/error-envelope';
import WebSocket from 'ws';
import type { CapabilityCall } from '@kb-labs/host-agent-contracts';
import type { AdapterCallContext } from '@kb-labs/gateway-contracts';

export type CallHandler = (call: CapabilityCall) => Promise<unknown>;

/** Adapter call input — used by GatewayTransport */
export interface AdapterCallInput {
  adapter: string;
  method: string;
  args: unknown[];
  timeout?: number;
  context: AdapterCallContext;
}

/** Adapter call response — returned by sendAdapterCall */
export interface AdapterCallResponse {
  requestId: string;
  result?: unknown;
  error?: ErrorEnvelope;
}

export interface GatewayClientOptions {
  /** wss://gateway.example.com */
  gatewayUrl: string;
  agentVersion: string;
  /** Returns current valid access token */
  getAccessToken: () => string;
  /** Called when connection is established and handshake complete */
  onConnected?: (hostId: string, sessionId: string) => void;
  /** Called when disconnected */
  onDisconnected?: () => void;
  /** Called when token needs refresh (triggered before reconnect) */
  onTokenExpired?: () => Promise<void>;
  /** Capabilities this host provides — sent in hello message so Gateway can route by capability */
  capabilities?: string[];
  /** Host type for workspace agent routing */
  hostType?: 'local' | 'cloud';
  /** Workspace info advertised on connect */
  workspaces?: Array<{ workspaceId: string; repoFingerprint?: string; branch?: string }>;
  /** Plugin inventory advertised on connect */
  plugins?: Array<{ id: string; version: string }>;
  /** Optional logger for connection diagnostics */
  logger?: {
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
    debug(msg: string, meta?: Record<string, unknown>): void;
  };
}

const HEARTBEAT_INTERVAL_MS = 30_000;
const HELLO_TIMEOUT_MS = 5_000;
const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
const DEFAULT_ADAPTER_CALL_TIMEOUT_MS = 30_000;

/** Pending execute tunnel — callbacks for streaming events from Gateway */
interface PendingExecute {
  onEvent: (event: unknown) => void;
  onDone: (result: unknown) => void;
  onError: (error: Error) => void;
}

export class GatewayClient {
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = BACKOFF_INITIAL_MS;
  private stopped = false;
  private hostId: string | null = null;
  private reconnectCount = 0;
  private disconnectedAt: number | null = null;
  private pendingCalls = new Map<string, (result: unknown) => void>();
  private handlers = new Map<string, CallHandler>();
  /** Pending reverse adapter calls (Host → Gateway → Platform) */
  private pendingAdapterCalls = new Map<string, {
    resolve: (response: AdapterCallResponse) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(private readonly opts: GatewayClientOptions) {}

  /** Register a handler for calls to a specific adapter */
  registerHandler(adapter: string, handler: CallHandler): void {
    this.handlers.set(adapter, handler);
  }

  /**
   * Send an adapter call to Platform via Gateway WS (reverse proxy).
   * Used by GatewayTransport to proxy ctx.llm, ctx.cache, etc. back to Brain.
   *
   * Flow: Host → WS adapter:call → Gateway → HTTP → REST API → platform adapter → result
   */
  sendAdapterCall(call: AdapterCallInput): Promise<AdapterCallResponse> {
    return new Promise<AdapterCallResponse>((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket not connected'));
        return;
      }

      const requestId = randomUUID();
      const timeoutMs = call.timeout ?? DEFAULT_ADAPTER_CALL_TIMEOUT_MS;

      const timer = setTimeout(() => {
        this.pendingAdapterCalls.delete(requestId);
        reject(new Error(`Adapter call timed out after ${timeoutMs}ms: ${call.adapter}.${call.method}`));
      }, timeoutMs);

      this.pendingAdapterCalls.set(requestId, { resolve, reject, timer });

      this.send({
        type: 'adapter:call',
        requestId,
        adapter: call.adapter,
        method: call.method,
        args: call.args,
        timeout: call.timeout,
        context: call.context,
      });
    });
  }

  /**
   * Tunnel an execute request to Gateway via HTTP REST API.
   * CLI → IPC → Host Agent → HTTP POST /api/v1/execute → Gateway → Server.
   * Gateway responds with ndjson stream of ExecutionEvent objects.
   *
   * We use HTTP (not WS) because the WS channel is for Gateway→Host calls,
   * not Host→Gateway execute requests.
   */
  executeTunnel(
    requestId: string,
    command: string,
    params: Record<string, unknown> | undefined,
    callbacks: PendingExecute,
  ): void {
    // Parse command: "pluginId:handlerRef"
    const colonIdx = command.indexOf(':');
    const pluginId = colonIdx > 0 ? command.slice(0, colonIdx) : command;
    const handlerRef = colonIdx > 0 ? command.slice(colonIdx + 1) : command;

    const body = {
      pluginId,
      handlerRef,
      exportName: (params?.exportName as string) ?? handlerRef,
      input: params?.input ?? {},
      timeoutMs: (params?.timeoutMs as number) ?? undefined,
    };

    const token = this.opts.getAccessToken();
    const url = `${this.opts.gatewayUrl}/api/v1/execute`;

    // Fire-and-forget async fetch with ndjson streaming
    void this.doExecuteHttp(url, token, requestId, body, callbacks);
  }

  private async doExecuteHttp(
    url: string,
    token: string,
    requestId: string,
    body: Record<string, unknown>,
    callbacks: PendingExecute,
  ): Promise<void> {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        callbacks.onError(new Error(`Gateway HTTP ${res.status}: ${text}`));
        return;
      }

      if (!res.body) {
        callbacks.onError(new Error('Gateway returned no response body'));
        return;
      }

      // Read ndjson stream
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) {break;}

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) {continue;}

          try {
            const event = JSON.parse(trimmed) as Record<string, unknown>;
            callbacks.onEvent(event);

            if (event.type === 'execution:done') {
              callbacks.onDone(event);
            }
          } catch {
            // Ignore malformed lines
          }
        }
      }

      // Process remaining buffer
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer.trim()) as Record<string, unknown>;
          callbacks.onEvent(event);
          if (event.type === 'execution:done') {
            callbacks.onDone(event);
          }
        } catch {
          // Ignore
        }
      }
    } catch (err) {
      callbacks.onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** Cancel a pending execute via Gateway REST API */
  cancelExecute(executionId: string, reason?: string): void {
    const token = this.opts.getAccessToken();
    const url = `${this.opts.gatewayUrl}/api/v1/execute/${executionId}/cancel`;

    void fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ reason: reason ?? 'user' }),
    }).catch(() => {
      // Best-effort cancel — ignore network errors
    });
  }

  async connect(): Promise<void> {
    this.stopped = false;
    await this.doConnect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.ws?.close(1000, 'agent stopped');
    this.ws = null;
  }

  private async doConnect(): Promise<void> {
    const token = this.opts.getAccessToken();
    const wsUrl = this.opts.gatewayUrl.replace(/^http/, 'ws') + '/hosts/connect';

    // Security model:
    //   wss:// — always allowed (encrypted, public or private)
    //   ws://  — allowed only on trusted networks:
    //     • loopback (localhost, 127.0.0.1)
    //     • RFC-1918 private IP ranges (10.x, 172.16-31.x, 192.168.x)
    //     • host.docker.internal (macOS/Windows Docker Desktop bridge)
    //     • GATEWAY_ALLOW_WS=1 — explicit opt-in for custom setups
    //       (workflow-daemon sets this when spawning runtime containers on a
    //        trusted Docker bridge network where the service name is not an IP)
    const isSecureWs = wsUrl.startsWith('wss://');
    const isLoopback = wsUrl.startsWith('ws://localhost') || wsUrl.startsWith('ws://127.0.0.1');
    const isPrivateIp = /^ws:\/\/(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|host\.docker\.internal)/.test(wsUrl);
    const isExplicitlyAllowed = process.env.GATEWAY_ALLOW_WS === '1';
    if (!isSecureWs && !isLoopback && !isPrivateIp && !isExplicitlyAllowed) {
      throw new Error(`GatewayClient: insecure WebSocket URL rejected — must use wss:// (got ${wsUrl})`);
    }

    this.ws = new WebSocket(wsUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });

    this.ws.on('open', () => this.onOpen());
    this.ws.on('message', (data) => this.onMessage(data.toString()));
    this.ws.on('close', () => this.onClose());
    this.ws.on('error', (err) => { this.opts.logger?.warn('WS error', { error: err.message }); });
  }

  private onOpen(): void {
    this.send({
      type: 'hello',
      protocolVersion: '1.0',
      agentVersion: this.opts.agentVersion,
      hostId: this.hostId ?? undefined,
      capabilities: this.opts.capabilities ?? [],
      hostType: this.opts.hostType,
      workspaces: this.opts.workspaces,
      plugins: this.opts.plugins,
    });

    // Timeout if no 'connected' reply
    const helloTimeout = setTimeout(() => {
      this.ws?.close(1008, 'hello timeout');
    }, HELLO_TIMEOUT_MS);

    this.ws!.once('message', (data) => {
      clearTimeout(helloTimeout);
      let msg: { type: string; hostId?: string; sessionId?: string };
      try {
        msg = JSON.parse(data.toString()) as { type: string; hostId?: string; sessionId?: string };
      } catch {
        this.ws?.close(1008, 'malformed handshake message');
        return;
      }
      if (msg.type === 'connected' && msg.hostId && typeof msg.hostId === 'string') {
        const reconnectMs = this.disconnectedAt ? Date.now() - this.disconnectedAt : 0;
        this.hostId = msg.hostId;
        this.backoffMs = BACKOFF_INITIAL_MS;
        this.disconnectedAt = null;
        if (this.reconnectCount > 0) {
          this.opts.logger?.info('Reconnected', { hostId: msg.hostId, attempt: this.reconnectCount, reconnectMs });
        }
        this.reconnectCount = 0;
        this.startHeartbeat();
        this.opts.onConnected?.(msg.hostId, msg.sessionId ?? '');
      } else {
        this.ws?.close(1008, 'unexpected message during handshake');
      }
    });
  }

  private onMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    const type = msg['type'] as string;

    if (type === 'call') {
      void this.handleCall(msg as unknown as CapabilityCall);
      return;
    }

    // Adapter reverse proxy responses (from Gateway/Platform back to us)
    if (type === 'adapter:response') {
      const requestId = msg['requestId'] as string;
      const pending = this.pendingAdapterCalls.get(requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingAdapterCalls.delete(requestId);
        pending.resolve({ requestId, result: msg['result'] });
      }
      return;
    }

    if (type === 'adapter:error') {
      const requestId = msg['requestId'] as string;
      const pending = this.pendingAdapterCalls.get(requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingAdapterCalls.delete(requestId);
        const error = msg['error'] as ErrorEnvelope;
        pending.resolve({ requestId, error });
      }
      return;
    }

    // heartbeat ack — no action needed
  }

  private async handleCall(call: CapabilityCall): Promise<void> {
    const handler = this.handlers.get(call.adapter);
    if (!handler) {
      this.send({
        type: 'error',
        requestId: call.requestId,
        error: { code: 'UNKNOWN_ADAPTER', message: `No handler for adapter: ${call.adapter}`, retryable: false },
      });
      return;
    }

    try {
      const result = await handler(call);
      this.send({ type: 'chunk', requestId: call.requestId, data: result, index: 0 });
      this.send({ type: 'result', requestId: call.requestId, done: true });
    } catch (err) {
      const error = err instanceof ErrorEnvelopeError
        ? err.envelope
        : isErrorEnvelope(err)
          ? err
          : serialize(err);
      this.send({
        type: 'error',
        requestId: call.requestId,
        error,
      });
    }
  }

  private onClose(): void {
    this.clearTimers();
    this.disconnectedAt = this.disconnectedAt ?? Date.now();
    this.rejectAllPendingAdapterCalls();
    this.opts.onDisconnected?.();
    if (!this.stopped) {
      this.opts.logger?.warn('Disconnected, scheduling reconnect', { hostId: this.hostId, backoffMs: this.backoffMs });
      this.scheduleReconnect();
    }
  }

  /** Reject all pending adapter calls on disconnect (at-most-once semantics) */
  private rejectAllPendingAdapterCalls(): void {
    const error = new Error('WebSocket disconnected — all pending adapter calls rejected');
    for (const [requestId, pending] of this.pendingAdapterCalls) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingAdapterCalls.clear();
  }

  private scheduleReconnect(): void {
    this.reconnectCount++;
    this.opts.logger?.debug('Reconnect scheduled', { attempt: this.reconnectCount, backoffMs: this.backoffMs });
    this.reconnectTimer = setTimeout(async () => {
      if (this.stopped) {return;}
      await this.opts.onTokenExpired?.();
      await this.doConnect();
      this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
    }, this.backoffMs);
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: 'heartbeat' });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private clearTimers(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }

  private send(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }
}
