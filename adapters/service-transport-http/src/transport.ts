import { Pool } from 'undici';
import type {
  IServiceTransport,
  ServiceConnectionInfo,
  ProjectServiceConnectionInfo,
  ServiceListenAddress,
  ServiceTransportRequest,
  ServiceTransportResponse,
  ServiceTransportStream,
  ServiceTransportHealth,
} from '@kb-labs/sdk';

export interface HttpServiceTransportConfig {
  services: Record<string, {
    url: string;
    socketPath?: string;
    timeoutMs?: number;
  }>;
  /** Cloud addresses keyed by project id and project service id. */
  projectServices?: Record<string, Record<string, {
    url: string;
    socketPath?: string;
  }>>;
  /**
   * Per-environment TCP port shift, added to every service url's port. Sockets
   * are unaffected (they isolate via KB_SOCKET_HASH path, not port). This is a
   * LOCAL mechanism for running multiple environments on one host; in
   * cloud/k8s the offset is 0 and isolation comes from namespace/DNS. Falls
   * back to the KB_NET_OFFSET env var when not set in config.
   */
  offset?: number;
}

/**
 * Shift the port of a TCP url by offset, leaving scheme/host/path intact.
 * No-op for offset 0, urls without an explicit port (e.g. socket placeholders),
 * or unparseable urls. The single helper used for both route and bind so the
 * two never drift.
 */
export function applyPortOffset(url: string, offset: number): string {
  if (!offset) return url;
  try {
    const u = new URL(url);
    if (!u.port) return url;
    u.port = String(Number(u.port) + offset);
    return u.toString().replace(/\/$/, '');
  } catch {
    return url;
  }
}

function assertResolvedSocketPath(socketPath: string, serviceId: string): void {
  if (/\$\{[^}]+\}/.test(socketPath)) {
    throw new Error(
      `Service "${serviceId}" has an unresolved placeholder in socketPath: "${socketPath}". ` +
      `Check that the required environment variable is set (e.g. KB_SOCKET_HASH).`,
    );
  }
}

export class HttpServiceTransport implements IServiceTransport {
  private readonly pools = new Map<string, Pool>();
  private readonly offset: number;

  constructor(private readonly config: HttpServiceTransportConfig) {
    this.offset = config.offset ?? (Number(process.env.KB_NET_OFFSET) || 0);
    for (const [id, svc] of Object.entries(config.services)) {
      // Socket services route via socketPath; their url is a placeholder, so
      // the offset is harmlessly skipped. TCP services get the shifted url.
      const base = svc.socketPath ? svc.url : applyPortOffset(svc.url, this.offset);
      this.pools.set(id, new Pool(base, {
        ...(svc.socketPath ? { socketPath: svc.socketPath } : {}),
        connections: 10,
        pipelining: 0,
      }));
    }
  }

  /** Publishes a module's actual ephemeral bind address into this transport. */
  async publishListenAddress(
    serviceId: string,
    address: { host: string; port: number },
  ): Promise<void> {
    const previous = this.pools.get(serviceId);
    this.config.services[serviceId] = {
      url: `http://${address.host}:${address.port}`,
    };
    this.pools.set(serviceId, new Pool(this.config.services[serviceId]!.url, {
      connections: 10,
      pipelining: 0,
    }));
    await previous?.close();
  }

  connectionInfo(serviceId: string): ServiceConnectionInfo | undefined {
    const svc = this.config.services[serviceId];
    if (!svc) return undefined;
    if (svc.socketPath) assertResolvedSocketPath(svc.socketPath, serviceId);
    const baseUrl = svc.socketPath ? svc.url : applyPortOffset(svc.url, this.offset);
    return { baseUrl, socketPath: svc.socketPath };
  }

  async resolveProjectService(
    projectId: string,
    serviceId: string,
  ): Promise<ProjectServiceConnectionInfo | undefined> {
    const service = this.config.projectServices?.[projectId]?.[serviceId];
    if (!service) {
      return undefined;
    }
    if (service.socketPath) {
      assertResolvedSocketPath(service.socketPath, serviceId);
    }
    return {
      baseUrl: service.socketPath ? service.url : applyPortOffset(service.url, this.offset),
      socketPath: service.socketPath,
      pathPrefix: "",
    };
  }

  listenAddress(serviceId: string): ServiceListenAddress | undefined {
    const svc = this.config.services[serviceId];
    if (!svc) return undefined;
    if (svc.socketPath) {
      assertResolvedSocketPath(svc.socketPath, serviceId);
      return { socketPath: svc.socketPath };
    }
    // Same offset as the route, so bind and route ports never drift. Host is
    // omitted — the local adapter doesn't own the bind host; the daemon keeps
    // its own host config. Guard a url without an explicit port (would parse to
    // 0): return undefined so the caller falls back to its default port.
    let port: number;
    try {
      const u = new URL(applyPortOffset(svc.url, this.offset));
      if (!u.port) return undefined;
      port = Number(u.port);
    } catch {
      return undefined;
    }
    return { port };
  }

  async call(serviceId: string, req: ServiceTransportRequest): Promise<ServiceTransportResponse> {
    const { statusCode, headers, body } = await this._request(serviceId, req);
    const payload = await body.json().catch(async () => {
      const text = await body.text().catch(() => undefined);
      return text ?? undefined;
    });
    return { ok: statusCode < 400, statusCode, payload, metadata: headers as Record<string, string> };
  }

  async stream(serviceId: string, req: ServiceTransportRequest): Promise<ServiceTransportStream> {
    const { statusCode, headers, body } = await this._request(serviceId, req);
    return {
      ok: statusCode < 400,
      statusCode,
      body: body as unknown as AsyncIterable<Uint8Array>,
      metadata: headers as Record<string, string>,
    };
  }

  private async _request(serviceId: string, req: ServiceTransportRequest) {
    const pool = this.pools.get(serviceId);
    if (!pool) throw new Error(`Unknown service: ${serviceId}`);

    const svc = this.config.services[serviceId]!;
    const method = req.metadata?.['http-method'] ?? (req.payload !== undefined ? 'POST' : 'GET');

    return pool.request({
      method,
      path: req.path,
      headers: {
        ...(req.payload !== undefined ? { 'content-type': 'application/json' } : {}),
        ...req.metadata,
      },
      body: req.payload !== undefined ? JSON.stringify(req.payload) : undefined,
      headersTimeout: req.timeoutMs ?? svc.timeoutMs ?? 30_000,
      signal: req.signal,
    });
  }

  async health(): Promise<ServiceTransportHealth> {
    const results: Record<string, boolean> = {};
    await Promise.allSettled(
      Object.keys(this.config.services).map(async id => {
        try {
          const res = await this.call(id, { path: '/health' });
          results[id] = res.ok;
        } catch {
          results[id] = false;
        }
      }),
    );
    const allOk = Object.values(results).every(Boolean);
    return { status: allOk ? 'ok' : 'degraded', services: results };
  }

  /** Drain and close all connection pools. */
  async destroy(): Promise<void> {
    await Promise.allSettled(
      Array.from(this.pools.values()).map(pool => pool.destroy()),
    );
    this.pools.clear();
  }
}
