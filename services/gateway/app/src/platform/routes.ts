/**
 * @module Unified Platform API — single dispatch for any adapter.
 *
 * Route: POST /platform/v1/{adapter}/{method}
 *
 * Provides a single entry point for all platform adapters (LLM, Cache,
 * VectorStore, Analytics, Storage, Embeddings, etc.). Adapter and method
 * come from URL params; arguments come from the request body.
 *
 * Security: only methods explicitly listed in ALLOWED_METHODS are callable.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { platform } from '@kb-labs/core-runtime';
import type { ILogger } from '@kb-labs/core-platform';
import { sendAuthError } from '../auth/error-response.js';
import { PERMISSIONS } from '@kb-labs/core-contracts';
import { createErrorEnvelope, toErrorEnvelope } from '@kb-labs/core-platform/error-envelope';
import { createUxFailureResult, createUxSuccessResult } from '@kb-labs/core-platform/ux-result';
import {
  PlatformCallRequestJsonSchema,
  type PlatformCallRequest,
} from '@kb-labs/gateway-contracts';

// ── Method allowlist ──────────────────────────────────────────────────────
// Only methods listed here are callable via the Platform API.
// Internal/lifecycle methods (setSource, shutdown, etc.) are NOT exposed.
// Intentionally static — new methods must be added here explicitly;
// dynamic derivation from the adapter list would bypass security review.

const ALLOWED_METHODS: Record<string, Set<string>> = {
  llm: new Set(['complete', 'stream', 'chatWithTools']),
  cache: new Set(['get', 'set', 'delete', 'clear']),
  vectorStore: new Set(['search', 'upsert', 'delete', 'count']),
  analytics: new Set(['track', 'identify', 'flush', 'getEvents', 'getStats', 'getDailyStats']),
  embeddings: new Set(['embed']),
  storage: new Set(['read', 'write', 'delete', 'list', 'exists']),
  eventBus: new Set(['publish', 'subscribe']),
  documentDatabase: new Set([
    'find', 'findById', 'count',
    'insertOne', 'insertMany',
    'updateOne', 'updateMany', 'updateById',
    'deleteMany', 'deleteById',
    'bulkWrite',
    'ensureCollection',
    'ping',
  ]),
  kvStore: new Set([
    'get', 'getMany',
    'set', 'setMany', 'setIfNotExists',
    'delete', 'exists',
    'cas', 'incr',
    'ttl', 'expire', 'persist',
    'ping',
  ]),
};

const ADMIN_ONLY_ADAPTERS = new Set(['cache', 'storage', 'eventBus', 'documentDatabase', 'kvStore']);
const ADAPTER_CATALOG_PATH = '/platform/v1/adapters';

function sendPlatformFailure(
  reply: FastifyReply,
  statusCode: number,
  error: Parameters<typeof createUxFailureResult>[0],
): FastifyReply {
  return reply.code(statusCode).send(createUxFailureResult(error));
}

// ── Adapter resolution ────────────────────────────────────────────────────

function resolveAdapter(name: string): unknown | undefined {
  // Map URL param to platform property
  const adapterMap: Record<string, () => unknown> = {
    llm: () => platform.llm,
    cache: () => platform.cache,
    analytics: () => platform.analytics,
    vectorStore: () => platform.vectorStore,
    embeddings: () => platform.embeddings,
    storage: () => platform.storage,
    eventBus: () => platform.eventBus,
    documentDatabase: () => platform.documentDatabase,
    kvStore: () => platform.kvStore,
  };

  const getter = adapterMap[name];
  return getter ? getter() : undefined;
}

// ── Streaming detection ───────────────────────────────────────────────────

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    Symbol.asyncIterator in (value as object)
  );
}

function streamErrorEnvelope(
  adapterName: string,
  error: Error,
  correlationId: string,
  timing: 'starting' | 'streaming',
) {
  if (adapterName === 'llm') {
    const providerError = error as Error & { status?: number; statusCode?: number };
    const status = providerError.status ?? providerError.statusCode;
    if (status === 401 || status === 403 || error.name === 'AuthenticationError') {
      return createErrorEnvelope('KB_CONFIG_LLM_KEY_INVALID', {
        details: { provider: 'configured LLM provider' },
        message: 'The LLM provider rejected the configured API key.',
        hint: "Check `platform.adapterOptions.llm.apiKey`, then run `kb config set --scope platform platform.adapterOptions.llm.apiKey '${OPENAI_API_KEY}'` and restart the host.",
        correlationId,
      });
    }
    if (status === 429 || error.name === 'RateLimitError') {
      return createErrorEnvelope('KB_CONFIG_LLM_QUOTA', {
        details: { provider: 'configured LLM provider' },
        message: 'The LLM provider quota or budget is exhausted.',
        hint: 'Check provider quota for the configured model with `kb config get platform.adapterOptions.llm.model --scope platform --json`, then choose a model with available quota.',
        correlationId,
      });
    }
    if (status === 408 || status === 504 || error.name.includes('Timeout')) {
      return createErrorEnvelope('KB_CONFIG_LLM_PROVIDER_TIMEOUT', {
        hint: 'Check `platform.adapterOptions.llm.baseURL` and provider availability with `kb config get platform.adapterOptions.llm.baseURL --scope platform --json`; then retry.',
        correlationId,
      });
    }
    return createErrorEnvelope('KB_CONFIG_LLM_PROVIDER_UNAVAILABLE', {
      hint: 'Check `platform.adapterOptions.llm.baseURL` and provider availability with `kb config get platform.adapterOptions.llm.baseURL --scope platform --json`; then retry.',
      correlationId,
    });
  }
  const owner = adapterName === 'llm' ? 'LLM provider' : `platform adapter "${adapterName}"`;
  return createErrorEnvelope('KB_RUNTIME_UNEXPECTED', {
    message: `The configured ${owner} failed while ${timing} the response.`,
    hint: `Run "kb config show --json" and check platform.adapterOptions.${adapterName}, then retry. If it persists, report correlationId.`,
    correlationId,
  });
}

// ── Route registration ────────────────────────────────────────────────────

export function registerPlatformRoutes(app: FastifyInstance, logger: ILogger): void {
  app.get(
    ADAPTER_CATALOG_PATH,
    {
      config: { uxFixture: { validResult: 'error-envelope' } },
      schema: {
        tags: ['Platform'],
        summary: 'List callable platform adapter methods',
        querystring: { type: 'object', properties: {}, additionalProperties: false },
        response: { 200: {
          type: 'object',
          properties: {
            ok: { type: 'boolean', const: true },
            data: {
              type: 'object',
              properties: {
                adapters: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } } },
              },
              required: ['adapters'],
            },
          },
          required: ['ok', 'data'],
        } },
      },
    },
    async (request, reply) => {
      if (!request.authContext) {
        return sendAuthError(reply, 401);
      }

      const adapters = Object.fromEntries(
        Object.entries(ALLOWED_METHODS).map(([adapter, methods]) => [adapter, [...methods]]),
      );
      return reply.send(createUxSuccessResult({ adapters }));
    },
  );

  // hide: true — can return SSE (text/event-stream) for streaming adapter calls, incompatible with OpenAPI response schema
  app.post<{ Params: { adapter: string; method: string }; Body: PlatformCallRequest }>(
    '/platform/v1/:adapter/:method',
    {
      config: { uxFixture: { validResult: 'error-envelope' } },
      schema: {
        tags: ['Platform'],
        summary: 'Invoke a platform adapter method',
        hide: true,
        params: {},
        querystring: {},
        body: PlatformCallRequestJsonSchema,
        response: { 200: {} },
      },
    },
    async (request, reply) => {
      const auth = request.authContext;
      if (!auth) {
        return sendAuthError(reply, 401);
      }

      const { adapter: adapterName, method: methodName } = request.params;

      if (auth.type === 'user' && ADMIN_ONLY_ADAPTERS.has(adapterName) && !auth.permissions.includes(PERMISSIONS.PLATFORM_SETTINGS_READ)) {
        return sendAuthError(reply, 403, PERMISSIONS.PLATFORM_SETTINGS_READ, undefined, undefined, { durationMs: 0 });
      }

      // 1. Check adapter is in allowlist
      const allowedMethods = ALLOWED_METHODS[adapterName];
      if (!allowedMethods) {
        return sendPlatformFailure(reply, 404, createErrorEnvelope('KB_RUNTIME_RESOURCE_NOT_FOUND', {
          message: `Unknown adapter: "${adapterName}".`,
          hint: `Request GET ${ADAPTER_CATALOG_PATH} to see supported adapter methods, then retry.`,
        }));
      }

      // 2. Check method is allowed
      if (!allowedMethods.has(methodName)) {
        return sendPlatformFailure(reply, 403, createErrorEnvelope('KB_AUTH_FORBIDDEN', {
          details: { permission: 'platform adapter method' },
          cause: `Method "${methodName}" is not allowed on adapter "${adapterName}".`,
          hint: `Request GET ${ADAPTER_CATALOG_PATH} to see supported adapter methods, then retry.`,
        }));
      }

      // 3. Resolve adapter instance
      const adapter = resolveAdapter(adapterName);
      if (!adapter) {
        return sendPlatformFailure(reply, 503, createErrorEnvelope('KB_ADAPTER_NOT_CONFIGURED', {
          details: { service: adapterName, adapter: adapterName, command: `kb adapter bind ${adapterName}` },
        }));
      }

      // 4. Check method exists on adapter
      const method = (adapter as Record<string, unknown>)[methodName];
      if (typeof method !== 'function') {
        return sendPlatformFailure(reply, 501, createErrorEnvelope('KB_RUNTIME_RESOURCE_NOT_FOUND', {
          message: `Method "${methodName}" is not implemented on adapter "${adapterName}".`,
        }));
      }

      // 5. Parse args
      const args = request.body?.args ?? [];
      if (adapterName === 'llm' && methodName === 'stream'
        && (typeof args[0] !== 'string' || args[0].trim().length === 0)) {
        return sendPlatformFailure(reply, 400, createErrorEnvelope('KB_RUNTIME_INPUT_INVALID', {
          message: 'An LLM stream prompt is required.',
          hint: 'Pass a non-empty prompt as the first stream argument and retry.',
          correlationId: request.id,
        }));
      }

      logger.info('Platform API call', {
        adapter: adapterName,
        method: methodName,
        argCount: args.length,
        tenantId: auth.namespaceId,
      });

      // 6. Execute
      const startTime = Date.now();

      try {
        const result = method.apply(adapter, args);

        // Handle async results
        const resolved = result instanceof Promise ? await result : result;

        // 7. Detect streaming response (e.g., llm.stream)
        if (isAsyncIterable(resolved)) {
          const iterator = resolved[Symbol.asyncIterator]();
          let first: IteratorResult<unknown>;
          try {
            first = await iterator.next();
          } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            logger.error('Platform API stream failed before its first chunk', error, {
              adapter: adapterName,
              method: methodName,
              tenantId: auth.namespaceId,
            });
            return sendPlatformFailure(reply, 502, streamErrorEnvelope(adapterName, error, request.id, 'starting'));
          }

          reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          });
          reply.raw.flushHeaders();

          const writeChunk = (chunk: unknown): void => {
            if (!reply.raw.writableEnded && !reply.raw.destroyed) {
              const data = typeof chunk === 'string' ? chunk : JSON.stringify(chunk);
              reply.raw.write(`data: ${data}\n\n`);
            }
          };

          if (!first.done) {
            writeChunk(first.value);
          }

          while (!first.done && !reply.raw.writableEnded && !reply.raw.destroyed) {
            try {
              first = await iterator.next();
            } catch (err) {
              const error = err instanceof Error ? err : new Error(String(err));
              logger.error('Platform API stream failed after headers were sent', error, {
                adapter: adapterName,
                method: methodName,
                tenantId: auth.namespaceId,
              });
              reply.raw.write(`event: error\ndata: ${JSON.stringify({
              ok: false,
              error: streamErrorEnvelope(adapterName, error, request.id, 'streaming'),
              })}\n\n`);
              reply.raw.end();
              return reply;
            }

            if (!first.done) {
              writeChunk(first.value);
            }
          }

          if (!reply.raw.writableEnded && !reply.raw.destroyed) {
            reply.raw.write('data: [DONE]\n\n');
            reply.raw.end();
          }

          return reply;
        }

        // 8. Regular response
        const durationMs = Date.now() - startTime;
        return reply.code(200).send(createUxSuccessResult(
          resolved === undefined ? null : resolved,
          { durationMs },
        ));
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (reply.raw.headersSent) {
          logger.error('Platform API stream failed after headers were sent', error, {
            adapter: adapterName,
            method: methodName,
            tenantId: auth.namespaceId,
          });
          if (!reply.raw.writableEnded && !reply.raw.destroyed) {
            reply.raw.write(`event: error\ndata: ${JSON.stringify({
              ok: false,
              error: streamErrorEnvelope(adapterName, error, request.id, 'streaming'),
            })}\n\n`);
            reply.raw.end();
          }
          return reply;
        }

        logger.error('Platform API error', error, {
          adapter: adapterName,
          method: methodName,
          tenantId: auth.namespaceId,
        });
        const envelope = adapterName === 'llm' && methodName === 'stream'
          ? streamErrorEnvelope(adapterName, error, request.id, 'starting')
          : toErrorEnvelope(error, { correlationId: request.id });
        return sendPlatformFailure(reply, 502, envelope);
      }
    },
  );
}
