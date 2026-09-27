/**
 * Adapter Registry — single source of truth for the platform adapter pipeline.
 *
 * Every adapter that exists in PlatformServices must have exactly one entry here.
 * TypeScript enforces exhaustiveness at compile time via `satisfies`.
 *
 * Pipeline per adapter (left → right):
 *   raw → [routerFactory] → [resourceBrokerFactory] → [governance] → plugin
 */

import type {
  PlatformServices,
  PluginServices,
  PermissionSpec,
  VectorRecord,
  VectorFilter,
  LLMAdapter,
  EmbeddingsAdapter,
  VectorStoreAdapter,
  CacheAdapter,
  StorageAdapter,
} from '@kb-labs/plugin-contracts';
import { PermissionError } from '@kb-labs/plugin-contracts';
import type { INotifier, ILLM, ILLMRouter, IEmbeddings, IVectorStore, IAnalytics, ILogger, PIIRedactionConfig, UseLLMOptions } from '@kb-labs/core-platform';
import {
  AnalyticsLLM,
  AnalyticsEmbeddings,
  AnalyticsVectorStore,
  AnalyticsCache,
  AnalyticsStorage,
  createPIIRedactionLLM,
} from '@kb-labs/core-platform';
import type { IResourceBroker } from '@kb-labs/core-resource-broker';
import {
  createQueuedLLM,
  createQueuedEmbeddings,
  createQueuedVectorStore,
} from '@kb-labs/core-resource-broker';
import { LLMRouter, type LLMRouterConfig } from '@kb-labs/llm-router';
import {
  CacheProxy,
  LLMProxy,
  EmbeddingsProxy,
  VectorStoreProxy,
  StorageProxy,
  DocumentDatabaseProxy,
  KVStoreProxy,
  ConfigProxy,
  EventBusProxy,
} from '@kb-labs/core-ipc';
import type { AdapterDescriptor, AdapterMiddlewareFn } from './middleware.js';
import { wrapDocumentDatabase, wrapKVStore } from './database-governance.js';

// ─── Shared helpers ─────────────────────────────────────────────────────────

/** Create a denied stub that throws PermissionError on any property access. */
function createDeniedService<T>(serviceName: string): T {
  return new Proxy({} as object, {
    get() {
      throw new PermissionError(`Platform service '${serviceName}' access denied`);
    },
  }) as unknown as T;
}

// ─── Governance wrap functions ───────────────────────────────────────────────

const wrapLogger: AdapterMiddlewareFn<PlatformServices['logger']> = (adapter, ctx) =>
  adapter.child({ plugin: ctx.pluginId });

const wrapLlm: AdapterMiddlewareFn<LLMAdapter> = (adapter, ctx) => {
  if (!ctx.permissions.platform?.llm) {
    return createDeniedService<LLMAdapter>('llm');
  }

  const allowedModels =
    typeof ctx.permissions.platform.llm === 'object'
      ? (ctx.permissions.platform.llm as { models?: string[] }).models
      : undefined;

  const checkModel = (model: string | undefined) => {
    if (allowedModels && model && !allowedModels.includes(model)) {
      throw new PermissionError(
        `LLM model '${model}' not allowed. Permitted: ${allowedModels.join(', ')}`,
      );
    }
  };

  const wrapped: LLMAdapter = {
    complete: async (prompt, options) => {
      checkModel(options?.model);
      return adapter.complete(prompt, options);
    },
    stream: async function* (prompt, options) {
      checkModel(options?.model);
      yield* adapter.stream(prompt, options);
    },
    ...(adapter.chatWithTools
      ? { chatWithTools: (messages, options) => adapter.chatWithTools!(messages, options) }
      : {}),
  };

  // Preserve the router contract across the plugin permission boundary. Without
  // this, consumers cannot preflight capabilities or bind a tier; `useLLM()`
  // silently degrades to the default model. Resolved bindings stay wrapped so
  // model allowlists are still enforced on the concrete adapter call.
  const router = adapter as unknown as ILLMRouter;
  if (typeof router.getConfiguredTier === 'function') {
    Object.assign(wrapped, {
      getConfiguredTier: () => router.getConfiguredTier(),
      resolve: (options?: UseLLMOptions) => router.resolve(options),
      resolveAdapter: async (options?: UseLLMOptions) => {
        const binding = await router.resolveAdapter(options);
        checkModel(binding.model);
        return { ...binding, adapter: wrapLlm(binding.adapter, ctx) };
      },
      hasCapability: (capability: Parameters<ILLMRouter['hasCapability']>[0]) =>
        router.hasCapability(capability),
      getCapabilities: () => router.getCapabilities(),
      supportsCapabilities: (options?: UseLLMOptions) => router.supportsCapabilities(options),
    });
  }

  return wrapped;
};

const wrapEmbeddings: AdapterMiddlewareFn<EmbeddingsAdapter> = (adapter, ctx) => {
  if (!ctx.permissions.platform?.embeddings) {
    return createDeniedService<EmbeddingsAdapter>('embeddings');
  }
  return {
    embed: (text) => adapter.embed(text),
    embedBatch: (texts) => adapter.embedBatch(texts),
    get dimensions() { return adapter.dimensions; },
    getDimensions: () => adapter.getDimensions(),
  };
};

const wrapVectorStore: AdapterMiddlewareFn<VectorStoreAdapter> = (adapter, ctx) => {
  if (!ctx.permissions.platform?.vectorStore) {
    return createDeniedService<VectorStoreAdapter>('vectorStore');
  }

  const rawPermission = ctx.permissions.platform.vectorStore;
  const permission =
    rawPermission === true
      ? true
      : typeof rawPermission === 'object'
        ? (rawPermission as { collections?: string[] }).collections
        : undefined;

  const namespace: string | undefined =
    permission === true || !permission || permission.length === 0
      ? undefined
      : permission[0];

  const prefixId = (id: string): string => {
    if (!namespace || id.startsWith(namespace)) {return id;}
    return `${namespace}${id}`;
  };

  // Inverse of `prefixId`: results must round-trip the id the caller upserted,
  // otherwise consumers that correlate results by id (e.g. fusing vector hits
  // back to their source records) silently drop every result.
  //
  // CAVEAT (asymmetry): `prefixId` is idempotent — it does NOT prefix an id that
  // already `startsWith(namespace)` — while `stripId` strips unconditionally. So
  // a caller id whose *natural* value begins with the namespace token would be
  // corrupted on read (`<namespace>foo` → upserted unprefixed → read → `foo`).
  // This is safe for current usage: namespaces are collection tokens ending in
  // `:` (e.g. `mind:`) and real ids (chunk ids = `path#a-b`) never start with
  // them. A bulletproof fix needs a structured/delimited id rather than a bare
  // string prefix — tracked as a platform design item, not changed here.
  const stripId = <T extends { id: string }>(r: T): T =>
    namespace && r.id.startsWith(namespace) ? { ...r, id: r.id.slice(namespace.length) } : r;

  const filterByNamespace = <T extends { metadata?: Record<string, unknown> }>(results: T[]): T[] => {
    if (!namespace) {return results;}
    return results.filter(
      (r) => !r.metadata?.['_kbNamespace'] || r.metadata['_kbNamespace'] === namespace,
    );
  };

  // `ns` is the caller-supplied per-call namespace (e.g. mind's indexId) and is
  // forwarded transparently to the adapter — orthogonal to the plugin-level
  // governance namespacing (id-prefix + _kbNamespace metadata) applied here.
  return {
    search: async (query: number[], limit: number, filter?: VectorFilter, ns?: string) => {
      const results = await adapter.search(query, limit, filter, ns);
      return filterByNamespace(results).map(stripId);
    },
    upsert: async (vectors: VectorRecord[], ns?: string) => {
      const prefixed = vectors.map((v) => ({
        ...v,
        id: prefixId(v.id),
        metadata: namespace ? { ...v.metadata, _kbNamespace: namespace } : v.metadata,
      }));
      return adapter.upsert(prefixed, ns);
    },
    delete: async (ids: string[], ns?: string) => adapter.delete(ids.map(prefixId), ns),
    count: (ns?: string) => adapter.count(ns),
    ...(adapter.get
      ? { get: async (ids: string[], ns?: string) => (await adapter.get!(ids.map(prefixId), ns)).map(stripId) }
      : {}),
    ...(adapter.query
      ? {
          query: async (filter: VectorFilter, ns?: string) => {
            const results = await adapter.query!(filter, ns);
            return filterByNamespace(results).map(stripId);
          },
        }
      : {}),
  } as VectorStoreAdapter;
};

const wrapCache: AdapterMiddlewareFn<CacheAdapter> = (adapter, ctx) => {
  const perm = ctx.permissions.platform?.cache;

  if (!perm) {return createDeniedService<CacheAdapter>('cache');}

  const checkKey = (key: string) => {
    if (perm === true) {return;}
    const allowed = (perm as { namespaces?: string[] }).namespaces ?? [];
    if (!allowed.some((ns) => key.startsWith(ns))) {
      throw new PermissionError(
        `Cache key '${key}' not allowed. Permitted namespaces: ${allowed.join(', ')}`,
      );
    }
  };

  return {
    get: async (key) => { checkKey(key); return adapter.get(key); },
    set: async (key, value, ttl) => { checkKey(key); return adapter.set(key, value, ttl); },
    delete: async (key) => { checkKey(key); return adapter.delete(key); },
    clear: async (pattern) => {
      if (perm !== true) {throw new PermissionError('Cache.clear() requires full cache permission');}
      return adapter.clear(pattern);
    },
    zadd: async (key, score, member) => { checkKey(key); return adapter.zadd(key, score, member); },
    zrangebyscore: async (key, min, max) => { checkKey(key); return adapter.zrangebyscore(key, min, max); },
    zrem: async (key, member) => { checkKey(key); return adapter.zrem(key, member); },
    setIfNotExists: async (key, value, ttl) => { checkKey(key); return adapter.setIfNotExists(key, value, ttl); },
  };
};

const wrapStorage: AdapterMiddlewareFn<StorageAdapter> = (adapter, ctx) => {
  const perm = ctx.permissions.platform?.storage;
  if (!perm) {return createDeniedService<StorageAdapter>('storage');}

  const checkPath = (path: string) => {
    if (perm === true) {return;}
    const allowed = (perm as { paths?: string[] }).paths ?? [];
    if (!allowed.some((base) => path.startsWith(base))) {
      throw new PermissionError(
        `Storage path '${path}' not allowed. Permitted paths: ${allowed.join(', ')}`,
      );
    }
  };

  return {
    read: async (path) => { checkPath(path); return adapter.read(path); },
    write: async (path, data) => { checkPath(path); return adapter.write(path, data); },
    delete: async (path) => { checkPath(path); return adapter.delete(path); },
    exists: async (path) => { checkPath(path); return adapter.exists(path); },
    list: async (prefix) => { checkPath(prefix); return adapter.list(prefix); },
  };
};

const wrapNotifier: AdapterMiddlewareFn<INotifier> = (adapter, ctx) => {
  const perm = ctx.permissions.platform?.notifier;
  if (!perm) {return createDeniedService<INotifier>('notifier');}

  const canEmit = perm.emit === true;
  const subPerm = perm.subscribe;
  const wildcardSources = subPerm?.sources.includes('*') ?? false;
  const allowedSources: string[] | undefined = wildcardSources ? undefined : subPerm?.sources;
  const allowedSeverity = subPerm?.severity;

  return {
    notify: canEmit
      ? (event) => adapter.notify({ ...event, source: ctx.pluginId })
      : () => Promise.reject(new PermissionError('Notifier emit access denied')),

    subscribe: subPerm
      ? (filter, handler) =>
          adapter.subscribe(filter, async (event) => {
            if (allowedSources && !allowedSources.includes(event.source ?? '')) {return;}
            if (allowedSeverity && !allowedSeverity.includes(event.severity ?? 'info')) {return;}
            await handler(event);
          })
      : () => { throw new PermissionError('Notifier subscribe access denied'); },
  } satisfies INotifier;
};

// ─── Registry ────────────────────────────────────────────────────────────────

/**
 * Single source of truth for all platform adapters.
 *
 * Adding a new field to PluginServices causes a compile error here.
 * Platform-only fields (e.g. serviceTransport) live in PlatformServices only
 * and must NOT be in this registry — they are excluded from plugin context.
 * until a corresponding entry is added. Each entry declares (in pipeline order):
 *   - analyticsFactory:      optional tracking wrap (before router)
 *   - routerFactory:         optional platform-level routing (LLMRouter, etc.)
 *   - resourceBrokerFactory: optional rate limiting / queuing
 *   - postAssemblyFactory:   optional outermost wrap (e.g. PII redaction)
 *   - governance:            plugin-level permission enforcement
 *   - ipc:                   how the adapter crosses the process boundary
 *
 * Pipeline per adapter (left → right, applied by assemblePlatform):
 *   raw → [analyticsFactory] → [routerFactory] → [resourceBrokerFactory] → [postAssemblyFactory] → [governance] → plugin
 */
export const ADAPTER_REGISTRY = {
  logger: {
    governance: { strategy: 'wrap', fn: wrapLogger },
    ipc: { strategy: 'local' },
  },

  llm: {
    analyticsFactory: (raw: ILLM, analytics: IAnalytics) =>
      new AnalyticsLLM(raw, analytics),
    routerFactory: (raw: ILLM, config: unknown) => {
      // config includes { adapterLoader, logger, defaultTier, tierMapping, capabilities, ... }
      // assembled by loader.ts and passed through assemblyHook → assemblePlatform
      const c = config as LLMRouterConfig & { logger?: ILogger };
      return new LLMRouter(raw, c, c.logger);
    },
    resourceBrokerFactory: (raw: ILLM, broker: unknown) =>
      createQueuedLLM(broker as IResourceBroker, raw),
    postAssemblyFactory: (raw: ILLM, config: unknown) => {
      const privacyCfg = (config as { _privacy?: PIIRedactionConfig })._privacy;
      if (!privacyCfg || privacyCfg.enabled === false) { return raw; }
      return createPIIRedactionLLM(raw, privacyCfg);
    },
    governance: { strategy: 'wrap', fn: wrapLlm },
    ipc: { strategy: 'proxy', create: (t) => new LLMProxy(t) },
  },

  embeddings: {
    analyticsFactory: (raw: IEmbeddings, analytics: IAnalytics) =>
      new AnalyticsEmbeddings(raw, analytics),
    resourceBrokerFactory: (raw: IEmbeddings, broker: unknown) =>
      createQueuedEmbeddings(broker as IResourceBroker, raw),
    governance: { strategy: 'wrap', fn: wrapEmbeddings },
    ipc: { strategy: 'proxy', create: (t) => new EmbeddingsProxy(t) },
  },

  vectorStore: {
    analyticsFactory: (raw: IVectorStore, analytics: IAnalytics) =>
      new AnalyticsVectorStore(raw, analytics),
    resourceBrokerFactory: (raw: IVectorStore, broker: unknown) =>
      createQueuedVectorStore(broker as IResourceBroker, raw),
    governance: { strategy: 'wrap', fn: wrapVectorStore },
    ipc: { strategy: 'proxy', create: (t) => new VectorStoreProxy(t) },
  },

  cache: {
    analyticsFactory: (raw: CacheAdapter, analytics: IAnalytics) =>
      new AnalyticsCache(raw, analytics),
    governance: { strategy: 'wrap', fn: wrapCache },
    ipc: { strategy: 'proxy', create: (t) => new CacheProxy(t) },
  },

  storage: {
    analyticsFactory: (raw: StorageAdapter, analytics: IAnalytics) =>
      new AnalyticsStorage(raw, analytics),
    governance: { strategy: 'wrap', fn: wrapStorage },
    ipc: { strategy: 'proxy', create: (t) => new StorageProxy(t) },
  },

  analytics: {
    governance: { strategy: 'pass-through' },
    ipc: {
      strategy: 'noop',
      create: () => ({
        track: async () => {},
        identify: async () => {},
        flush: async () => {},
      }),
    },
  },

  eventBus: {
    governance: { strategy: 'pass-through' },
    ipc: { strategy: 'proxy', create: (t) => new EventBusProxy(t) },
  },

  config: {
    governance: { strategy: 'pass-through' },
    ipc: { strategy: 'proxy', create: (t) => new ConfigProxy(t) },
  },

  invoke: {
    governance: { strategy: 'pass-through' },
    ipc: {
      strategy: 'noop',
      create: () => ({
        call: async () => ({ success: false as const, error: 'Invoke not available in proxy context' }),
        isAvailable: async () => false,
      }),
    },
  },

  documentDatabase: {
    governance: {
      strategy: 'wrap',
      fn: (adapter, ctx) =>
        wrapDocumentDatabase(adapter, ctx.pluginId, ctx.permissions),
    },
    ipc: { strategy: 'proxy', create: (t) => new DocumentDatabaseProxy(t) },
  },

  kvStore: {
    governance: {
      strategy: 'wrap',
      fn: (adapter, ctx) =>
        wrapKVStore(adapter, ctx.pluginId, ctx.permissions),
    },
    ipc: { strategy: 'proxy', create: (t) => new KVStoreProxy(t) },
  },

  logs: {
    governance: { strategy: 'pass-through' },
    ipc: {
      strategy: 'noop',
      create: () => ({
        query: async () => ({ logs: [] as never[], total: 0, hasMore: false, source: 'buffer' as const }),
        getById: async () => null,
        search: async () => ({ logs: [] as never[], total: 0, hasMore: false }),
        subscribe: () => () => {},
        getStats: async () => ({}),
        getCapabilities: () => ({
          hasBuffer: false,
          hasPersistence: false,
          hasSearch: false,
          hasStreaming: false,
        }),
      }),
    },
  },

  // Optional adapters — absent from IPC worker (no proxy implementation yet)
  notifier: {
    governance: { strategy: 'wrap', fn: wrapNotifier },
    ipc: { strategy: 'absent' },
  },

  artifacts: {
    governance: { strategy: 'pass-through' },
    ipc: { strategy: 'absent' },
  },

  snapshotManager: {
    governance: { strategy: 'pass-through' },
    ipc: { strategy: 'absent' },
  },
 
} satisfies { [K in keyof Required<PluginServices>]: AdapterDescriptor<any> };

export type AdapterRegistryKey = keyof typeof ADAPTER_REGISTRY;

// Plain data derivative of ADAPTER_REGISTRY's key set — the registry itself
// holds governance/factory functions and isn't safe to serialize or expose
// on a public API surface. This is: consumers (e.g. the kb-create installer)
// that need to validate a capability/role name against the canonical list
// without pulling in the runtime's internals.
export const ADAPTER_REGISTRY_KEYS: AdapterRegistryKey[] =
  Object.keys(ADAPTER_REGISTRY) as AdapterRegistryKey[];

// Re-export for consumers that only need the governance helpers
export {
  wrapLogger,
  wrapLlm,
  wrapEmbeddings,
  wrapVectorStore,
  wrapCache,
  wrapStorage,
  wrapNotifier,
  createDeniedService,
};

// Re-export permission spec type for use by wrap functions
export type { PermissionSpec };
