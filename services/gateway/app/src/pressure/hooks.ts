/**
 * @module pressure/hooks
 * Fastify hooks that apply pressure-control via `IResourceBroker.tryAcquire`.
 *
 * Three hooks:
 *   - `onRequest` (per-service / per-route) — runs before auth, returns 429 if denied.
 *   - `preHandler` (per-tenant) — runs after auth, keyed by AuthContext.namespaceId.
 *   - `onResponse` — releases every slot reserved during the request.
 *
 * Aborted connections are caught via `request.raw.on('close', ...)`. Idempotency
 * of `release` (core ResourceBroker guarantee) makes double-fire safe.
 *
 * SSE / WebSocket requests are skipped (long-lived connections would hold a slot
 * past `onResponse`). Detection is via the `Upgrade` header.
 */

import type { FastifyRequest, FastifyReply, onRequestHookHandler, preHandlerHookHandler, onResponseHookHandler } from 'fastify';
import type { IResourceBroker, TryAcquireResult } from '@kb-labs/core-resource-broker';
import type { ILogger } from '@kb-labs/core-platform';
import type { GatewayConfig } from '@kb-labs/gateway-contracts';
import { redactHttpUrl } from '@kb-labs/shared-http';
import { resolveResourceId } from './resolve.js';

import './types.js';

export interface PressureHooksDeps {
  broker: IResourceBroker;
  logger: ILogger;
  config: GatewayConfig;
}

/**
 * Returns true if the request is a WS/SSE upgrade and must be skipped.
 */
function shouldSkip(request: FastifyRequest): boolean {
  const upgrade = request.headers.upgrade;
  if (typeof upgrade === 'string' && upgrade.length > 0) { return true; }
  return false;
}

/**
 * Initialize the per-request release array and arm an `onClose` safety net.
 * Called from the very first hook that may add a release handle.
 */
function armRequest(request: FastifyRequest): Array<() => Promise<void>> {
  if (!request.pressureReleases) {
    request.pressureReleases = [];
    request.raw.on('close', () => {
      void releaseAll(request);
    });
  }
  return request.pressureReleases;
}

async function releaseAll(request: FastifyRequest): Promise<void> {
  const releases = request.pressureReleases;
  if (!releases || releases.length === 0) { return; }
  // Snapshot + clear so a second pass (close after finish) is a no-op.
  const snapshot = releases.slice();
  request.pressureReleases = [];
  for (const release of snapshot) {
    try {
      await release();
    } catch {
      // Release errors are non-fatal; broker idempotency means slot may
      // already be free. Surface via logger if we ever need it, but stay
      // silent here to avoid amplifying noise on shutdown / aborted conns.
    }
  }
}

function retryAfterSeconds(waitTimeMs: number | undefined): number {
  if (!waitTimeMs || waitTimeMs <= 0) { return 1; }
  return Math.max(1, Math.ceil(waitTimeMs / 1000));
}

/**
 * Per-service / per-route hook. Runs as the first thing on every request.
 */
export function createPressureOnRequest(deps: PressureHooksDeps): onRequestHookHandler {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (shouldSkip(request)) { return; }

    const resolved = resolveResourceId(request.method, request.url, deps.config);
    if (!resolved) { return; }

    const acquired: TryAcquireResult = await deps.broker.tryAcquire(resolved.resource);

    if (!acquired.allowed) {
      const retryAfter = retryAfterSeconds(acquired.waitTimeMs);
      deps.logger.warn('pressure.rejected', {
        event: 'pressure.rejected',
        resource: resolved.resource,
        layer: resolved.layer,
        method: request.method,
        url: redactHttpUrl(request.url),
        waitTimeMs: acquired.waitTimeMs,
      });
      reply
        .code(429)
        .header('Retry-After', String(retryAfter))
        .send({
          error: 'rate_limited',
          resource: resolved.resource,
          waitTimeMs: acquired.waitTimeMs ?? null,
        });
      return reply;
    }

    armRequest(request).push(acquired.release);
  };
}

/**
 * Per-tenant hook. Runs after auth (inside the authenticated scope), so
 * `request.authContext.namespaceId` is available. Lazily registers a
 * limit-only resource per namespace on first encounter.
 *
 * Relies on `broker.registerLimit` idempotency (core ResourceBroker uses
 * `Map.set`) — a concurrent first-request race re-registers harmlessly.
 */
export function createPressurePreHandler(deps: PressureHooksDeps): preHandlerHookHandler {
  const registered = new Set<string>();
  const tenantCfg = deps.config.pressure?.perTenant;

  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!tenantCfg || tenantCfg.enabled !== true) { return; }
    if (shouldSkip(request)) { return; }

    const namespaceId = request.authContext?.namespaceId;
    if (!namespaceId) { return; }

    const resource = `gateway:tenant:${namespaceId}`;
    if (!registered.has(namespaceId)) {
      deps.broker.registerLimit(resource, tenantCfg.limits);
      registered.add(namespaceId);
      deps.logger.debug?.('pressure.tenant.registered', {
        event: 'pressure.tenant.registered',
        namespaceId,
      });
    }

    const acquired = await deps.broker.tryAcquire(resource);
    if (!acquired.allowed) {
      const retryAfter = retryAfterSeconds(acquired.waitTimeMs);
      deps.logger.warn('pressure.rejected', {
        event: 'pressure.rejected',
        resource,
        layer: 'tenant',
        method: request.method,
        url: redactHttpUrl(request.url),
        namespaceId,
        waitTimeMs: acquired.waitTimeMs,
      });
      reply
        .code(429)
        .header('Retry-After', String(retryAfter))
        .send({
          error: 'rate_limited',
          resource,
          waitTimeMs: acquired.waitTimeMs ?? null,
        });
      return reply;
    }

    armRequest(request).push(acquired.release);
  };
}

/**
 * Response hook that releases every pressure slot reserved for this request.
 */
export function createPressureOnResponse(): onResponseHookHandler {
  return async (request: FastifyRequest) => {
    await releaseAll(request);
  };
}
