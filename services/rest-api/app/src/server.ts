/**
 * @module @kb-labs/rest-api-app/server
 * Fastify server setup
 */

import Fastify from 'fastify';
import type { FastifyInstance, RouteOptions } from 'fastify';
import type { FastifyBaseLogger } from 'fastify';
import type { RestApiConfig } from '@kb-labs/rest-api-core';
import type { IEntityRegistry } from '@kb-labs/plugin-contracts';
import { registerRoutes } from './routes/index';
import { registerPluginRouteNotFoundHandler } from './routes/plugin-route-not-found.js';
import { registerPlugins } from './plugins';
import { registerMiddleware } from './middleware/index';
import { platform } from '@kb-labs/core-runtime';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import type { ILogger } from '@kb-labs/core-platform';

/**
 * Fastify internal symbol to disable request logging
 */
const kDisableRequestLogging = Symbol.for('fastify.disableRequestLogging');

function serializeForLog(meta: object): string {
  return JSON.stringify(meta, (_key, value) => {
    if (value instanceof Error) {
      return { name: value.name, message: value.message, stack: value.stack };
    }
    return value;
  });
}

/**
 * Create a Pino-compatible wrapper for ILogger
 * Fastify 5 expects a Pino instance, but we want vendor independence
 */
function createPinoCompatibleLogger(logger: ILogger): FastifyBaseLogger {
  const levels = {
    trace: 10,
    debug: 20,
    info: 30,
    warn: 40,
    error: 50,
    fatal: 60,
  };

  return {
    // Pino log levels
    trace: (msg: string | object, ...args: unknown[]) => {
      if (typeof msg === 'object') {
        logger.debug(serializeForLog(msg), msg as Record<string, unknown>);
      } else {
        const meta = (typeof args[0] === 'object' && args[0] !== null) ? args[0] as Record<string, unknown> : undefined;
        logger.debug(msg, meta);
      }
    },
    debug: (msg: string | object, ...args: unknown[]) => {
      if (typeof msg === 'object') {
        logger.debug(serializeForLog(msg), msg as Record<string, unknown>);
      } else {
        const meta = (typeof args[0] === 'object' && args[0] !== null) ? args[0] as Record<string, unknown> : undefined;
        logger.debug(msg, meta);
      }
    },
    info: (msg: string | object, ...args: unknown[]) => {
      if (typeof msg === 'object') {
        logger.info(serializeForLog(msg), msg as Record<string, unknown>);
      } else {
        const meta = (typeof args[0] === 'object' && args[0] !== null) ? args[0] as Record<string, unknown> : undefined;
        logger.info(msg, meta);
      }
    },
    warn: (msg: string | object, ...args: unknown[]) => {
      if (typeof msg === 'object') {
        logger.warn(serializeForLog(msg), msg as Record<string, unknown>);
      } else {
        const meta = (typeof args[0] === 'object' && args[0] !== null) ? args[0] as Record<string, unknown> : undefined;
        logger.warn(msg, meta);
      }
    },
    error: (msg: string | object, ...args: unknown[]) => {
      if (typeof msg === 'object') {
        logger.error(serializeForLog(msg), msg instanceof Error ? msg : undefined);
      } else {
        logger.error(msg, args[0] instanceof Error ? args[0] : undefined);
      }
    },
    fatal: (msg: string | object, ...args: unknown[]) => {
      if (typeof msg === 'object') {
        logger.error(`[FATAL] ${serializeForLog(msg)}`, msg instanceof Error ? msg : undefined);
      } else {
        logger.error(`[FATAL] ${msg}`, args[0] instanceof Error ? args[0] : undefined);
      }
    },
    // Pino child method
    child: (bindings: Record<string, unknown>) => {
      const childLogger = logger.child(bindings);
      return createPinoCompatibleLogger(childLogger);
    },
    // Pino required properties for Fastify 5
    level: 'info',
    levels: {
      values: levels,
      labels: { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' },
    },
    silent: () => {},
    // Pino version symbol (required by Fastify 5 validation)
    [Symbol.for('pino.version')]: '8.0.0',
  } as unknown as FastifyBaseLogger;
}

/**
 * Create and configure Fastify server
 */
export async function createServer(
  config: RestApiConfig,
  repoRoot: string,
  registry: IEntityRegistry,
  routeObserver?: (route: RouteOptions) => void
): Promise<FastifyInstance> {
  // HTTP/2 configuration (requires HTTPS)
  const useHttp2 = config.http2?.enabled ?? false;
  const allowHTTP1 = config.http2?.allowHTTP1 ?? true;

  // SSL configuration
  let httpsOptions: { allowHTTP1: boolean; key: Buffer; cert: Buffer } | undefined;
  if (useHttp2 && config.ssl?.keyPath && config.ssl?.certPath) {
    const keyPath = config.ssl.keyPath;
    const certPath = config.ssl.certPath;

    if (existsSync(keyPath) && existsSync(certPath)) {
      httpsOptions = {
        allowHTTP1,
        key: readFileSync(keyPath),
        cert: readFileSync(certPath),
      };
    } else {
      platform.logger.warn('HTTP/2 enabled but SSL certificates not found, falling back to HTTP/1.1', {
        keyPath,
        certPath,
      });
    }
  }

  // Create platform logger child for REST layer
  const restLogger = platform.logger.child({
    layer: 'rest',
    service: 'server',
    traceId: randomUUID(),
  });

  // Fastify 5 is too strict with logger validation, so disable it and use hooks
  const server = useHttp2 && httpsOptions
    ? Fastify({
        logger: false,
        requestIdHeader: 'X-Request-Id',
        requestIdLogLabel: 'requestId',
        disableRequestLogging: true,
        requestTimeout: config.timeouts?.requestTimeout || 30000,
        bodyLimit: config.timeouts?.bodyLimit || 10485760,
        ajv: { customOptions: { removeAdditional: false } },
        http2: true,
        https: httpsOptions,
      })
    : Fastify({
        logger: false,
        requestIdHeader: 'X-Request-Id',
        requestIdLogLabel: 'requestId',
        disableRequestLogging: true,
        requestTimeout: config.timeouts?.requestTimeout || 30000,
        bodyLimit: config.timeouts?.bodyLimit || 10485760,
        ajv: { customOptions: { removeAdditional: false } },
      });

  // Add our own logger to server instance
  server.log = createPinoCompatibleLogger(restLogger);

  // Override child logger factory to return our custom logger with disable flag
  server.setChildLoggerFactory((logger, bindings, opts, rawReq) => {
    const customLogger = {
      [kDisableRequestLogging]: true, // Disable Fastify's built-in request logging
      debug: (_obj: unknown, _msg?: string) => {},
      info: (_obj: unknown, _msg?: string) => {},
      warn: (_obj: unknown, _msg?: string) => {},
      error: (_obj: unknown, _msg?: string) => {},
      fatal: (_obj: unknown, _msg?: string) => {},
      trace: (_obj: unknown, _msg?: string) => {},
      silent: (_obj: unknown, _msg?: string) => {},
      child: () => customLogger,
      level: 'silent',
    };
    return customLogger as unknown as FastifyBaseLogger;
  });

  // Log protocol being used
  if (useHttp2 && httpsOptions) {
    restLogger.info('HTTP/2 enabled with HTTPS', {
      allowHTTP1Fallback: allowHTTP1,
    });
  } else if (useHttp2) {
    restLogger.warn('HTTP/2 requested but SSL certificates missing, using HTTP/1.1');
  } else {
    restLogger.info('Using HTTP/1.1');
  }

  // Store registry in server instance
  server.registry = registry;

  if (routeObserver) {
    const observeRoute = (route: RouteOptions) => routeObserver(route);
    (server.addHook as unknown as (
      name: 'onRoute',
      hook: typeof observeRoute
    ) => void).call(server, 'onRoute', observeRoute);
  }

  // Register plugins
  await registerPlugins(server as unknown as FastifyInstance, config);

  // Register middleware
  registerMiddleware(server as unknown as FastifyInstance, config);

  // Register routes
  await registerRoutes(server as unknown as FastifyInstance, config, repoRoot, registry);
  registerPluginRouteNotFoundHandler(server as unknown as FastifyInstance, config, registry);

  return server as unknown as FastifyInstance;
}
