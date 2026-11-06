import { withUxErrorResponses } from './route-schema.js';
/**
 * @module @kb-labs/rest-api-app/routes/platform
 * Platform configuration endpoints
 */

import type { FastifyInstance } from 'fastify';
import type { RestApiConfig } from '@kb-labs/rest-api-core';
import type { PlatformConfigResponse, PlatformConfigPayload } from '@kb-labs/rest-api-contracts';
import { normalizeBasePath, resolvePaths } from './path-helpers';
import { readRawKbConfig } from '@kb-labs/core-config';
import { platform } from '@kb-labs/core-runtime';
import { restDomainOperationMetrics } from '../middleware/metrics.js';

/**
 * Sensitive keys to redact from adapterOptions
 */
const SENSITIVE_KEYS = [
  'apiKey',
  'secret',
  'password',
  'token',
  'key',
  'credentials',
  'auth',
];

/**
 * Recursively redact sensitive keys from an object
 */
function redactSensitiveData(
  obj: Record<string, any>,
  redacted: string[] = [],
  path: string = ''
): Record<string, any> {
  const result: Record<string, any> = {};

  for (const [key, value] of Object.entries(obj)) {
    const currentPath = path ? `${path}.${key}` : key;
    const lowerKey = key.toLowerCase();

    // Check if key contains sensitive patterns
    const isSensitive = SENSITIVE_KEYS.some(pattern => lowerKey.includes(pattern.toLowerCase()));

    if (isSensitive && typeof value === 'string') {
      result[key] = '***REDACTED***';
      redacted.push(currentPath);
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = redactSensitiveData(value, redacted, currentPath);
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Load platform configuration from kb.config.json using core-config utilities
 */
async function loadPlatformConfig(repoRoot: string): Promise<{
  adapters: Record<string, string | null>;
  adapterOptions: Record<string, unknown>;
  execution: { mode: string };
}> {
  try {
    const configResult = await readRawKbConfig(repoRoot);

    if (!configResult || !configResult.data) {
      // Return empty/default values if config not found
      return {
        adapters: {},
        adapterOptions: {},
        execution: { mode: 'in-process' },
      };
    }

    const config = configResult.data as Record<string, unknown>;
    const configPlatform = (typeof config.platform === 'object' && config.platform !== null)
      ? config.platform as Record<string, unknown>
      : {} as Record<string, unknown>;

    return {
      adapters: (configPlatform.adapters ?? {}) as Record<string, string | null>,
      adapterOptions: (configPlatform.adapterOptions ?? {}) as Record<string, unknown>,
      execution: (configPlatform.execution ?? { mode: 'in-process' }) as { mode: string },
    };
  } catch (error) {
    // Return empty/default values on error
    return {
      adapters: {},
      adapterOptions: {},
      execution: { mode: 'in-process' },
    };
  }
}

/**
 * Register platform configuration routes
 */
export async function registerPlatformRoutes(
  fastify: FastifyInstance,
  config: RestApiConfig,
  repoRoot: string
): Promise<void> {
  const basePath = normalizeBasePath(config.basePath);
  const configPaths = resolvePaths(basePath, '/platform/config');

  for (const path of configPaths) {
    fastify.get(path, { schema: {
      querystring: { type: 'object', additionalProperties: false },
      response: withUxErrorResponses({ 200: { type: 'object', properties: { ok: { const: true }, data: { type: 'object', properties: { schema: { const: 'kb.platform.config/1' }, ts: { type: 'string', format: 'date-time' }, adapters: { type: 'object', additionalProperties: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }, { type: 'null' }] } }, adapterOptions: { type: 'object' }, execution: { type: 'object', properties: { mode: { type: 'string' } }, required: ['mode'], additionalProperties: false }, redacted: { type: 'array', items: { type: 'string' } } }, required: ['schema', 'ts', 'adapters', 'adapterOptions', 'execution', 'redacted'], additionalProperties: false } }, required: ['ok', 'data'], additionalProperties: false } }),
    } }, async (_request, reply) => {
      try {
        const { adapters, adapterOptions, execution } = await restDomainOperationMetrics.observeOperation(
          'platform.config.get',
          () => loadPlatformConfig(repoRoot),
        );

        const redacted: string[] = [];
        const sanitizedOptions = redactSensitiveData(adapterOptions as Record<string, any>, redacted);

        const payload: PlatformConfigPayload = {
          schema: 'kb.platform.config/1',
          ts: new Date().toISOString(),
          adapters,
          adapterOptions: sanitizedOptions,
          execution,
          redacted,
        };

        const response: PlatformConfigResponse = {
          ok: true,
          data: payload,
        };

        return reply.send(response);
      } catch (error) {
        platform.logger.error('Failed to load platform config', error instanceof Error ? error : new Error(String(error)));
        return reply.code(500).send({
          ok: false,
          error: {
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Failed to load platform configuration',
          },
        });
      }
    });
  }
}
