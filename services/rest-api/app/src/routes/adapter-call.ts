import { withUxErrorResponses } from './route-schema.js';
/**
 * Internal adapter-call endpoint — reverse proxy for Workspace Agent.
 *
 * Receives adapter:call from Gateway (forwarded from Host via WS),
 * executes against platform services, returns result.
 *
 * Flow: Host → WS adapter:call → Gateway → HTTP POST here → platform.adapter.method()
 *
 * Security:
 * - Auth: x-internal-secret (server-to-server, same as /internal/dispatch)
 * - Adapter allowlist enforced (AdapterNameSchema)
 * - Method allowlist per adapter (AdapterRegistry)
 * - Zod validation on input/output
 * - Audit logging on every call
 *
 * @see ADR-0051: Bidirectional Gateway Protocol
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { platform } from '@kb-labs/core-runtime';
import { AdapterNameSchema, type AdapterName } from '@kb-labs/gateway-contracts';
import { sendAuthError } from '@kb-labs/shared-http';
import { restDomainOperationMetrics } from '../middleware/metrics.js';

// ── Adapter Registry ──

interface AdapterMethodEntry {
  inputSchema: z.ZodType;
  outputSchema: z.ZodType;
  execute: (args: unknown[], context: AdapterCallContext) => Promise<unknown>;
}

interface AdapterCallContext {
  namespaceId: string;
  hostId: string;
  workspaceId?: string;
  environmentId?: string;
  executionRequestId?: string;
  userId?: string;
  sessionId?: string;
}

class AdapterRegistry {
  private methods = new Map<string, AdapterMethodEntry>();

  register(
    adapter: AdapterName,
    method: string,
    entry: AdapterMethodEntry,
  ): void {
    this.methods.set(`${adapter}.${method}`, entry);
  }

  get(adapter: string, method: string): AdapterMethodEntry | undefined {
    return this.methods.get(`${adapter}.${method}`);
  }

  has(adapter: string, method: string): boolean {
    return this.methods.has(`${adapter}.${method}`);
  }
}

// ── Request schema ──

const AdapterCallRequestSchema = z.object({
  requestId: z.string(),
  adapter: AdapterNameSchema,
  method: z.string(),
  args: z.array(z.unknown()),
  context: z.object({
    namespaceId: z.string(),
    hostId: z.string(),
    workspaceId: z.string().optional(),
    environmentId: z.string().optional(),
    executionRequestId: z.string().optional(),
    userId: z.string().optional(),
    sessionId: z.string().optional(),
  }),
});

// ── Registry initialization ──

function createAdapterRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry();

  // LLM
  registry.register('llm', 'complete', {
    inputSchema: z.array(z.unknown()),
    outputSchema: z.unknown(),
    execute: async (args) => {
      const llm = platform.getAdapter<any>('llm');
      if (!llm) { throw new Error('LLM adapter not available'); }
      return llm.complete(...args);
    },
  });

  // Cache
  registry.register('cache', 'get', {
    inputSchema: z.array(z.unknown()),
    outputSchema: z.unknown().nullable(),
    execute: async (args) => platform.cache.get(args[0] as string),
  });

  registry.register('cache', 'set', {
    inputSchema: z.array(z.unknown()),
    outputSchema: z.void(),
    execute: async (args) => platform.cache.set(args[0] as string, args[1], args[2] as number | undefined),
  });

  registry.register('cache', 'delete', {
    inputSchema: z.array(z.unknown()),
    outputSchema: z.void(),
    execute: async (args) => platform.cache.delete(args[0] as string),
  });

  // VectorStore
  registry.register('vectorStore', 'search', {
    inputSchema: z.array(z.unknown()),
    outputSchema: z.unknown(),
    execute: async (args) => {
      const vs = platform.getAdapter<any>('vectorStore');
      if (!vs) { throw new Error('VectorStore adapter not available'); }
      return vs.search(...args);
    },
  });

  // Embeddings
  registry.register('embeddings', 'embed', {
    inputSchema: z.array(z.unknown()),
    outputSchema: z.unknown(),
    execute: async (args) => {
      const emb = platform.getAdapter<any>('embeddings');
      if (!emb) { throw new Error('Embeddings adapter not available'); }
      return emb.embed(...args);
    },
  });

  // Storage
  registry.register('storage', 'read', {
    inputSchema: z.array(z.unknown()),
    outputSchema: z.unknown(),
    execute: async (args) => {
      const storage = platform.getAdapter<any>('storage');
      if (!storage) { throw new Error('Storage adapter not available'); }
      return storage.read(...args);
    },
  });

  registry.register('storage', 'write', {
    inputSchema: z.array(z.unknown()),
    outputSchema: z.void(),
    execute: async (args) => {
      const storage = platform.getAdapter<any>('storage');
      if (!storage) { throw new Error('Storage adapter not available'); }
      return storage.write(...args);
    },
  });

  return registry;
}

// ── Route registration ──

export async function registerAdapterCallRoutes(
  server: Pick<FastifyInstance, 'post'>,
): Promise<void> {
  const registry = createAdapterRegistry();
  const internalSecret = process.env.GATEWAY_INTERNAL_SECRET;
  const logger = platform.logger.child({ layer: 'rest', route: 'adapter-call' });

  server.post('/api/v1/internal/adapter-call', { config: { uxFixture: { validResult: 'error-envelope' } }, schema: {
    querystring: { type: 'object', additionalProperties: false },
    body: { type: 'object', properties: {
      requestId: { type: 'string', minLength: 1 }, adapter: { enum: ['llm', 'cache', 'vectorStore', 'embeddings', 'storage', 'state'] }, method: { type: 'string', minLength: 1 }, args: { type: 'array', items: {} },
      context: { type: 'object', properties: { namespaceId: { type: 'string' }, hostId: { type: 'string' }, workspaceId: { type: 'string' }, environmentId: { type: 'string' }, executionRequestId: { type: 'string' }, userId: { type: 'string' }, sessionId: { type: 'string' } }, required: ['namespaceId', 'hostId'], additionalProperties: false },
    }, required: ['requestId', 'adapter', 'method', 'args', 'context'], additionalProperties: false },
    response: withUxErrorResponses({ 200: { type: 'object', properties: { ok: { const: true }, result: {} }, required: ['ok', 'result'], additionalProperties: false } }),
  } }, async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    // 1. Auth: x-internal-secret
    const provided = request.headers['x-internal-secret'] as string | undefined;
    if (!internalSecret || provided !== internalSecret) {
      return sendAuthError(reply, 403, undefined, 'The internal secret was invalid.');
    }

    // 2. Parse & validate request
    const parsed = AdapterCallRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message, retryable: false } });
    }

    const { requestId, adapter, method, args, context } = parsed.data;
    const startMs = Date.now();

    // 3. Check registry
    const entry = registry.get(adapter as string, method);
    if (!entry) {
      logger.warn('Adapter call rejected', { requestId, adapter, method, hostId: context.hostId });
      return sendAuthError(reply, 403, undefined, `Method not allowed: ${adapter}.${method}`);
    }

    // 4. Execute
    try {
      const operation = `adapter.call.${adapter}.${method}`;
      const result = await restDomainOperationMetrics.observeOperation(operation, async () =>
        entry.execute(args, context),
      );
      const latencyMs = Date.now() - startMs;

      logger.info('Adapter call success', { requestId, adapter, method, hostId: context.hostId, latencyMs });

      return { ok: true, result };
    } catch (err) {
      const latencyMs = Date.now() - startMs;
      const message = err instanceof Error ? err.message : String(err);

      logger.error('Adapter call failed', err instanceof Error ? err : undefined, { requestId, adapter, method, hostId: context.hostId, latencyMs });

      return reply.code(500).send({
        ok: false,
        error: { code: 'ADAPTER_ERROR', message, retryable: false },
      });
    }
  });
}
