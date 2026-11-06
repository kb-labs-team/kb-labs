/**
 * @module @kb-labs/marketplace-api/server
 * Fastify server factory for marketplace service.
 */

import { type FastifyInstance } from 'fastify';
import {
  HttpObservabilityCollector,
  createDaemonServer,
  createServiceReadyResponse,
  type ObservabilityCollectorLike,
} from '@kb-labs/shared-http';
import type { IContextLogger } from '@kb-labs/core-platform';
import { createErrorEnvelope, createCatalogErrorEnvelope, getCatalogEntry, isErrorCode, toErrorEnvelope, type CatalogErrorRequest } from '@kb-labs/core-platform';
import type { ServiceHealthStatus, ObservabilityCheckStatus } from '@kb-labs/core-contracts';
import { registerRoutes } from './routes/index.js';
import { MarketplaceInstallRollbackError, MarketplaceVersionError, type MarketplaceService } from '@kb-labs/marketplace-core';
import { ScopeResolutionError, AdapterScopeError, InvalidEntityError, PackageClassificationError } from '@kb-labs/marketplace-core';
import { PackageInstallError, PackageMetadataError, PlatformArtifactPinsError, RegistryPackageError } from '@kb-labs/marketplace-npm';
import { ScopeRequestError } from './scope-parser.js';

export interface CreateServerOptions {
  service: MarketplaceService;
  logger: IContextLogger;
  port?: number;
  host?: string;
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
        checks: [{ id: 'marketplace-service', status: 'ok' as ObservabilityCheckStatus, message: 'Marketplace service registered' }],
        meta: { serviceHealthEndpoint: '/health' },
      }),
  };
}

export async function createServer(opts: CreateServerOptions): Promise<FastifyInstance> {
  const logger = opts.logger;

  const collector = new HttpObservabilityCollector({
    serviceId: 'marketplace',
    serviceType: 'http-api',
    version: '0.1.0',
    logsSource: 'marketplace',
  });
  const observability = wrapObservability(collector);

  return createDaemonServer({
    serviceId: 'marketplace',
    logger,
    observability,
    // Preserve the legacy /health contract { status:'ok', service, ts } (e2e MH-01/MH-02),
    // not the observability buildHealth() shape.
    healthResponse: () => ({ status: 'ok', service: 'marketplace', ts: Date.now() }),
    // /ready must return { ready, components } (createServiceReadyResponse shape),
    // not the bare buildHealth() payload — e2e MH-03/MH-04 assert body.ready and
    // body.components.marketplaceService.
    readyCheck: () =>
      createServiceReadyResponse({
        ready: true,
        components: { marketplaceService: { ready: true } },
      }),
    openapi: {
      title: 'KB Labs Marketplace',
      description: 'Unified marketplace for plugins, adapters, workflows, and more',
    },
    setErrorHandler: (app) => {
      // Keep all route failures on one catalog-backed response and logging boundary.
      app.setErrorHandler((unknownError, request, reply) => {
        const err = asError(unknownError);
        const correlationId = request.id;
        const body = request.body as { scope?: string } | undefined;
        const scope = typeof body?.scope === 'string' ? body.scope : 'platform';
        const mapped = mapMarketplaceError(err, correlationId, scope);
        logger.forOperation('marketplace.api.request', { requestId: correlationId }).error(
          'Marketplace API request failed',
          err,
          {
            correlationId,
            requestId: correlationId,
            errorCode: mapped.envelope.code,
            statusCode: mapped.statusCode,
            cause: mapped.envelope.cause,
          },
        );
        return reply.code(mapped.statusCode).send({ ok: false, error: mapped.envelope });
      });
    },
    registerRoutes: async (app) => {
      // Decorate with service and observability instances before registering routes.
      app.decorate('marketplace', opts.service);
      app.decorate('observability', collector);

      await collector.observeOperation('marketplace.bootstrap', () => registerRoutes(app));
    },
  });
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function mapMarketplaceError(err: Error, correlationId: string, scope: string): { statusCode: number; envelope: ReturnType<typeof createErrorEnvelope> } {
  if (err instanceof MarketplaceInstallRollbackError) {
    const entry = getCatalogEntry('KB_MARKETPLACE_INSTALL_FAILED');
    return {
      statusCode: entry?.httpStatus ?? 500,
      envelope: createErrorEnvelope('KB_MARKETPLACE_INSTALL_FAILED', {
        correlationId,
        message: err.message,
        hint: err.hint,
        details: { package: err.packageId, scope: err.scope, source: err.source },
        templateValues: { sourceName: err.source },
      }),
    };
  }

  type Diagnostic = CatalogErrorRequest;
  let diagnostic: Diagnostic = { code: 'KB_RUNTIME_UNEXPECTED', details: {} };
  let message: string | undefined;
  let hint: string | undefined;

  if ('validation' in err) {
    diagnostic = { code: 'KB_RUNTIME_INPUT_INVALID', details: {} };
    message = err.message;
  } else if (err instanceof ScopeRequestError || err instanceof ScopeResolutionError || err instanceof AdapterScopeError) {
    diagnostic = { code: 'KB_RUNTIME_INPUT_INVALID', details: {} };
    message = err.message;
  } else if (err instanceof InvalidEntityError || err instanceof PackageClassificationError) {
    diagnostic = { code: 'KB_MARKETPLACE_PACKAGE_INVALID', details: {} };
    message = err.message;
    hint = err instanceof PackageClassificationError ? err.hint : undefined;
  } else if (err instanceof PlatformArtifactPinsError) {
    diagnostic = { code: 'KB_MARKETPLACE_PLATFORM_ARTIFACT_PINS_MISSING', details: {} };
    message = err.message;
    hint = err.hint;
  } else if (err instanceof PackageMetadataError) {
    if (err.code === 'PACKAGE_NOT_FOUND') {
      diagnostic = { code: 'KB_PLUGIN_NOT_FOUND', details: { plugin: err.packageId } };
    } else if (err.code === 'AUTH_FAILED') {
      diagnostic = { code: 'KB_MARKETPLACE_AUTH_FAILED', details: { package: err.packageId, scope } };
    } else if (err.code === 'TRANSPORT_FAILED') {
      diagnostic = { code: 'KB_MARKETPLACE_TRANSPORT_FAILED', details: { package: err.packageId, scope } };
    } else {
      diagnostic = { code: 'KB_MARKETPLACE_RESOLUTION_FAILED', details: { package: err.packageId, scope } };
    }
  } else if (err instanceof RegistryPackageError) {
    if (err.code === 'SIGNATURE_INVALID') { diagnostic = { code: 'KB_MARKETPLACE_SIGNATURE_INVALID', details: { package: err.identity, scope } }; }
    else if (err.code === 'INTEGRITY_MISMATCH') { diagnostic = { code: 'KB_MARKETPLACE_INTEGRITY_MISMATCH', details: { package: err.identity, scope } }; }
    else if (err.code === 'AUTH_FAILED') { diagnostic = { code: 'KB_MARKETPLACE_AUTH_FAILED', details: { package: err.identity, scope } }; }
    else if (err.code === 'TRANSPORT_FAILED') { diagnostic = { code: 'KB_MARKETPLACE_TRANSPORT_FAILED', details: { package: err.identity, scope } }; }
    else if (err.code === 'IDENTITY_RESERVED') { diagnostic = { code: 'KB_MARKETPLACE_IDENTITY_RESERVED', details: { package: err.identity, scope } }; }
    else { diagnostic = { code: 'KB_MARKETPLACE_RESOLUTION_FAILED', details: { package: err.identity, scope } }; }
  } else if (err instanceof PackageInstallError) {
    if (err.code === 'NOT_FOUND') {
      diagnostic = { code: 'KB_PLUGIN_NOT_FOUND', details: { plugin: err.spec } };
    } else if (err.code === 'RELEASE_TOO_FRESH') {
      diagnostic = { code: 'KB_MARKETPLACE_PACKAGE_TOO_FRESH', details: { package: err.spec, scope } };
    } else if (err.code === 'INTEGRITY_MISMATCH') {
      diagnostic = { code: 'KB_MARKETPLACE_INTEGRITY_MISMATCH', details: { package: err.spec, scope } };
    } else {
      diagnostic = { code: 'KB_MARKETPLACE_INSTALL_FAILED', details: { package: err.spec, scope, source: 'npm' }, cause: err.message, templateValues: { sourceName: 'npm' } };
    }
  } else if (err instanceof MarketplaceVersionError) {
    if (err.code === 'INTEGRITY_MISMATCH') {
      diagnostic = { code: 'KB_MARKETPLACE_VERSION_IMMUTABLE', details: { package: err.packageId, installedVersion: err.installedVersion, requestedVersion: err.requestedVersion, scope } };
      message = err.message;
      hint = `Do not replace ${err.packageId}@${err.installedVersion}; publish a higher version, then run "kb marketplace install ${err.packageId}@latest --scope ${scope}".`;
    } else if (err.code === 'VERSION_NOT_HIGHER') {
      diagnostic = { code: 'KB_MARKETPLACE_VERSION_NOT_HIGHER', details: { package: err.packageId, installedVersion: err.installedVersion, requestedVersion: err.requestedVersion, scope } };
      message = err.message;
      hint = `Only a version higher than ${err.installedVersion} can be installed. Publish one, then run "kb marketplace update ${err.packageId} --scope ${scope}".`;
    } else {
      diagnostic = { code: 'KB_MARKETPLACE_RESOLUTION_FAILED', details: { package: err.packageId, scope } };
      message = err.message;
      hint = `Check the registry version metadata for ${err.packageId}, then retry the Marketplace operation.`;
    }
  }

  if (diagnostic.code === 'KB_RUNTIME_UNEXPECTED') {
    const catalogued = toErrorEnvelope(err, { correlationId });
    if (catalogued.code !== 'KB_RUNTIME_UNEXPECTED' && isErrorCode(catalogued.code)) {
      const catalogEntry = getCatalogEntry(catalogued.code);
      if (catalogEntry?.httpStatus) {
        return { statusCode: catalogEntry.httpStatus, envelope: catalogued };
      }
    }
  }

  const entry = getCatalogEntry(diagnostic.code);
  const contextual = { ...diagnostic, correlationId };
  const envelope = message !== undefined && hint !== undefined
    ? createCatalogErrorEnvelope({ ...contextual, message, hint })
    : message !== undefined
      ? createCatalogErrorEnvelope({ ...contextual, message })
      : hint !== undefined
        ? createCatalogErrorEnvelope({ ...contextual, hint })
        : createCatalogErrorEnvelope(contextual);
  return { statusCode: entry.httpStatus, envelope };
}
