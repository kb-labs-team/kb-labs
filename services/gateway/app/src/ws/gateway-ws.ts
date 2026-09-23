/**
 * @module gateway-app/ws/gateway-ws
 *
 * Unified WebSocket upgrade handler for the gateway.
 *
 * Intercepts upgrade requests BEFORE @fastify/http-proxy:
 *   - Gateway-own WS paths (/hosts/connect, /clients/connect) → raw ws handlers
 *   - Everything else → delegated to @fastify/http-proxy for upstream WS proxy
 *
 * This eliminates the conflict between @fastify/websocket and @fastify/http-proxy
 * which both try to attach 'upgrade' listeners and call assignSocket().
 */

import type { Server, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import type { ICache, ILogger } from '@kb-labs/core-platform';
import type { JwtConfig } from '@kb-labs/gateway-auth';
import { createWsHandler } from '../hosts/ws-handler.js';
import { createClientWsHandler } from '../clients/ws-handler.js';
import type { HostRegistry } from '../hosts/registry.js';
import { pumpBidirectional } from './pump.js';

const GATEWAY_WS_PATHS = new Set(['/hosts/connect', '/clients/connect']);

/**
 * A WS-enabled upstream reachable over a Unix domain socket. @fastify/http-proxy
 * cannot proxy WS upgrades over unix sockets, so the gateway dials these itself.
 */
export interface SocketWsUpstream {
  /** Gateway-side path prefix, e.g. "/api/v1". */
  prefix: string;
  /** Upstream-side prefix replacement (http-proxy rewritePrefix semantics). */
  rewritePrefix: string;
  /** Absolute unix socket path the upstream service is bound to. */
  socketPath: string;
}

/** Headers forwarded to the upstream WS handshake (auth, correlation, subprotocol). */
const FORWARDED_WS_HEADERS = [
  'authorization',
  'cookie',
  'x-request-id',
  'x-trace-id',
  'sec-websocket-protocol',
] as const;

/**
 * Pick the socket upstream that owns this pathname. Matches on a path boundary
 * (exact prefix or prefix followed by "/"), so "/api/v1x" does not match "/api/v1".
 *
 * Picks the LONGEST matching prefix, not the first one in `upstreams` order.
 * Upstream registration order comes from `Object.entries(config.upstreams)`,
 * which for a config rendered from a Go map is alphabetical by upstream name
 * (encoding/json sorts map keys) — unrelated to path specificity. A broad
 * catch-all like "rest" at "/api/v1" would otherwise silently steal every
 * request under a more specific nested prefix, e.g. a plugin's own WS
 * channels at "/api/v1/ws/plugins/<id>", registered under a different name
 * that happens to sort after "rest".
 */
export function pickSocketWsUpstream(
  pathname: string,
  upstreams: SocketWsUpstream[],
): SocketWsUpstream | undefined {
  let best: SocketWsUpstream | undefined;
  for (const u of upstreams) {
    if (pathname === u.prefix || pathname.startsWith(`${u.prefix}/`)) {
      if (!best || u.prefix.length > best.prefix.length) {best = u;}
    }
  }
  return best;
}

/**
 * Build the `ws+unix://<socket>:<path>` URL — the only form the `ws` client
 * accepts for a unix socket (the `socketPath` option is ignored by ws). The
 * gateway prefix is rewritten to the upstream prefix, query string preserved.
 */
export function buildUpstreamWsUrl(
  upstream: SocketWsUpstream,
  pathname: string,
  search: string,
): string {
  const rewritten = upstream.rewritePrefix + pathname.slice(upstream.prefix.length);
  return `ws+unix://${upstream.socketPath}:${rewritten}${search}`;
}

/** Extract the subset of request headers forwarded to the upstream WS handshake. */
export function forwardWsHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of FORWARDED_WS_HEADERS) {
    const value = req.headers[name];
    if (typeof value === 'string') {
      out[name] = value;
    }
  }
  return out;
}

/**
 * Attach gateway-own WebSocket endpoints using raw `ws` package.
 *
 * Must be called AFTER `app.ready()` (so http-proxy has registered its
 * upgrade listener) but BEFORE `app.listen()`.
 *
 * Captures all existing 'upgrade' listeners, removes them, then installs
 * a single unified handler that dispatches:
 *   - Gateway WS paths → raw ws handlers
 *   - All other paths → delegated to captured listeners (http-proxy)
 */
export function attachGatewayWs(
  server: Server,
  cache: ICache,
  jwtConfig: JwtConfig,
  logger: ILogger,
  hostRegistry?: HostRegistry,
  socketWsUpstreams: SocketWsUpstream[] = [],
): void {
  const wss = new WebSocketServer({ noServer: true });
  const hostsHandler = createWsHandler(cache, jwtConfig, logger, hostRegistry);
  const clientsHandler = createClientWsHandler(cache, jwtConfig, logger);

  // Capture @fastify/http-proxy's upgrade listener(s)
  const existingListeners = server.listeners('upgrade').slice() as Array<
    (req: IncomingMessage, socket: Duplex, head: Buffer) => void
  >;
  server.removeAllListeners('upgrade');

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;

    if (GATEWAY_WS_PATHS.has(pathname)) {
      // Gateway-own WS — handle directly with raw ws
      wss.handleUpgrade(req, socket, head, (ws) => {
        const handlerPromise = pathname === '/hosts/connect'
          ? hostsHandler(ws, req)
          : clientsHandler(ws, req);
        handlerPromise.catch((err) => {
          logger.error('Unhandled WS handler error', err instanceof Error ? err : new Error(String(err)), { pathname });
          try { ws.close(1011, 'Internal error'); } catch { /* already closed */ }
        });
      });
      return;
    }

    // Socket-bound upstream WS: @fastify/http-proxy can't dial unix sockets for
    // upgrades, so the gateway opens the upstream WS itself (ws+unix://) and
    // relays frames. TCP upstreams fall through to http-proxy below.
    const socketUpstream = pickSocketWsUpstream(pathname, socketWsUpstreams);
    if (socketUpstream) {
      const { search } = new URL(req.url ?? '/', 'http://localhost');
      const upstreamUrl = buildUpstreamWsUrl(socketUpstream, pathname, search);
      wss.handleUpgrade(req, socket, head, (clientWs) => {
        const requestId = typeof req.headers['x-request-id'] === 'string'
          ? req.headers['x-request-id']
          : randomUUID();
        const traceId = typeof req.headers['x-trace-id'] === 'string'
          ? req.headers['x-trace-id']
          : randomUUID();
        const connectionId = randomUUID();
        const connectionLogger = logger.child({
          requestId,
          traceId,
          'network.transport': 'websocket',
          'network.connection_id': connectionId,
          'http.route': pathname,
        }) ?? logger;
        connectionLogger.info('Gateway WebSocket relay opened', { event: 'websocket.relay.opened' });
        const upstreamWs = new WebSocket(upstreamUrl, {
          headers: { ...forwardWsHeaders(req), 'x-request-id': requestId, 'x-trace-id': traceId },
        });
        pumpBidirectional(clientWs, upstreamWs, connectionLogger);
      });
      return;
    }

    // Delegate to @fastify/http-proxy for TCP upstream WS proxy
    for (const listener of existingListeners) {
      listener.call(server, req, socket, head);
    }
  });

  logger.info('Gateway WS endpoints attached', { paths: [...GATEWAY_WS_PATHS] });
}
