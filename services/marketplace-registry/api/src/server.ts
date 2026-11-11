import { type FastifyInstance, type FastifyError } from 'fastify';
import multipart from '@fastify/multipart';
import {
  HttpObservabilityCollector,
  createDaemonServer,
  createServiceReadyResponse,
  type ObservabilityCollectorLike,
} from '@kb-labs/shared-http';
import type { ILogger } from '@kb-labs/core-platform';
import type { ServiceHealthStatus, ObservabilityCheckStatus } from '@kb-labs/core-contracts';
import type { RegistryService } from '@kb-labs/marketplace-registry-core';
import { registerPackageRoutes } from './routes/packages.js';
import { createRegistryAuthMiddleware } from './auth-middleware.js';

export interface RegistryServerOptions {
  port?: number;
  host?: string;
  logger: ILogger;
  registry: RegistryService;
  internalSecret?: string;
}

/**
 * Wraps HttpObservabilityCollector to satisfy ObservabilityCollectorLike.
 * The buildHealth() no-arg call from createDaemonServer routes uses a fixed
 * "service registered" check — the same information the original routes conveyed.
 */
function wrapObservability(collector: HttpObservabilityCollector): ObservabilityCollectorLike {
  return {
    register: (server: FastifyInstance) => collector.register(server),
    buildDescribe: () => collector.buildDescribe(),
    renderPrometheusMetrics: (status: string, extra?: string[]) => collector.renderPrometheusMetrics(status as ServiceHealthStatus, extra),
    buildHealth: (_params?: Record<string, unknown>) =>
      collector.buildHealth({
        status: 'healthy' as ServiceHealthStatus,
        checks: [{ id: 'registry-service', status: 'ok' as ObservabilityCheckStatus, message: 'Registry service registered' }],
        meta: { serviceHealthEndpoint: '/health' },
      }),
  };
}

export async function createRegistryServer(opts: RegistryServerOptions): Promise<FastifyInstance> {
  const { logger, registry, internalSecret } = opts;

  const collector = new HttpObservabilityCollector({
    serviceId: 'marketplace-registry',
    serviceType: 'http-api',
    version: '0.1.0',
    logsSource: 'marketplace-registry',
  });
  const observability = wrapObservability(collector);

  const server = await createDaemonServer({
    serviceId: 'marketplace-registry',
    logger,
    observability,
    onRequest: createRegistryAuthMiddleware(internalSecret),
    standardRouteConfig: { registryAccess: 'user' },
    // Preserve the legacy /health contract { status:'ok', service, ts } — e2e RG-H01.
    healthResponse: () => ({ status: 'ok', service: 'marketplace-registry', ts: Date.now() }),
    // /ready must return { ready, components } — e2e RG-H02 asserts body.ready === true.
    readyCheck: () =>
      createServiceReadyResponse({
        ready: true,
        components: { registryService: { ready: true } },
      }),
    openapi: {
      title: 'KB Labs Marketplace Registry',
      description: 'Public registry for KB Labs plugins and adapters',
    },
    setErrorHandler: (app) => {
      app.setErrorHandler((err: FastifyError, request, reply) => {
        const code: string = (err as FastifyError & { code?: string }).code ?? 'UNKNOWN';

        if (code === 'PACKAGE_NOT_FOUND' || code === 'VERSION_NOT_FOUND') {
          return reply.code(404).send({ error: 'NotFound', code, message: err.message });
        }
        if (code === 'VERSION_ALREADY_EXISTS') {
          return reply.code(409).send({ error: 'Conflict', code, message: err.message });
        }
        if (code === 'TARBALL_TOO_LARGE' || code === 'INVALID_MANIFEST') {
          return reply.code(422).send({ error: 'UnprocessableEntity', code, message: err.message });
        }
        if (code === 'FORBIDDEN' || code === 'VERSION_YANKED') {
          return reply.code(403).send({ error: 'Forbidden', code, message: err.message });
        }
        if (err.statusCode === 401) {
          return reply.code(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED', message: err.message });
        }
        // Unhandled error — log full stack so failures surface in service logs.
        logger.error('Unhandled registry error', err, {
          route: `${request.method} ${request.url}`,
          code,
        });
        return reply.code(500).send({ error: 'InternalServerError', code, message: err.message });
      });
    },
    registerRoutes: async (app) => {
      await app.register(multipart, { limits: { fileSize: 55 * 1024 * 1024 } });

      app.decorate('registry', registry);
      app.decorate('observability', collector);

      await collector.observeOperation('marketplace-registry.bootstrap', () =>
        registerPackageRoutes(app, registry),
      );
    },
  });

  return server;
}
