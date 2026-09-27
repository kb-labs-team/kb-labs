import { describe, it, expect, vi } from 'vitest';
import {
  wrapLlm,
  wrapCache,
  wrapStorage,
  wrapVectorStore,
  wrapEmbeddings,
  wrapNotifier,
  createDeniedService,
} from '../adapter-registry';
import { PermissionError } from '@kb-labs/plugin-contracts';
import type { ILLM, ILLMRouter } from '@kb-labs/core-platform';
import type { MiddlewareContext } from '../middleware';

function makeCtx(platform: Record<string, unknown> = {}): MiddlewareContext {
  return {
    pluginId: 'test-plugin',
    permissions: { platform: platform as never },
    lifecycle: { onReady: vi.fn(), onDispose: vi.fn(), on: vi.fn() },
  };
}

// ─── createDeniedService ──────────────────────────────────────────────────────

describe('createDeniedService', () => {
  it('throws PermissionError on any property access', () => {
    const denied = createDeniedService<{ foo: () => void }>('llm');
    expect(() => denied.foo).toThrow(PermissionError);
  });

  it('error message contains service name', () => {
    const denied = createDeniedService<{ x: number }>('myService');
    expect(() => denied.x).toThrow(/myService/);
  });
});

// ─── wrapLlm ─────────────────────────────────────────────────────────────────

describe('wrapLlm', () => {
  const baseLlm = {
    complete: vi.fn(async () => ({ content: 'ok', usage: { promptTokens: 1, completionTokens: 1 }, model: 'gpt-4o' })),
    stream: vi.fn(async function* () { yield 'chunk'; }),
  };

  it('denies when permission is false', () => {
    const wrapped = wrapLlm(baseLlm, makeCtx({ llm: false }));
    expect(() => (wrapped as any).complete).toThrow(PermissionError);
  });

  it('denies when platform.llm is absent', () => {
    const wrapped = wrapLlm(baseLlm, makeCtx({}));
    expect(() => (wrapped as any).complete).toThrow(PermissionError);
  });

  it('allows complete when permission is true', async () => {
    const adapter = { ...baseLlm, complete: vi.fn(async () => ({ content: 'ok', usage: { promptTokens: 1, completionTokens: 1 }, model: 'm' })) };
    const wrapped = wrapLlm(adapter, makeCtx({ llm: true }));
    await wrapped.complete('prompt');
    expect(adapter.complete).toHaveBeenCalledWith('prompt', undefined);
  });

  it('allows all models when permission is true (no allowlist)', async () => {
    const adapter = { ...baseLlm, complete: vi.fn(async () => ({ content: '', usage: { promptTokens: 1, completionTokens: 1 }, model: 'x' })) };
    const wrapped = wrapLlm(adapter, makeCtx({ llm: true }));
    await expect(wrapped.complete('p', { model: 'any-model' } as never)).resolves.toBeDefined();
  });

  it('blocks disallowed model when models allowlist is set', async () => {
    const adapter = { ...baseLlm };
    const wrapped = wrapLlm(adapter, makeCtx({ llm: { models: ['gpt-4o-mini'] } }));
    await expect(wrapped.complete('p', { model: 'gpt-4o' } as never)).rejects.toThrow(PermissionError);
  });

  it('allows model that is in the allowlist', async () => {
    const adapter = { ...baseLlm, complete: vi.fn(async () => ({ content: '', usage: { promptTokens: 1, completionTokens: 1 }, model: 'x' })) };
    const wrapped = wrapLlm(adapter, makeCtx({ llm: { models: ['gpt-4o-mini'] } }));
    await expect(wrapped.complete('p', { model: 'gpt-4o-mini' } as never)).resolves.toBeDefined();
  });

  it('preserves capability preflight and tier bindings through the permission wrapper', async () => {
    const adapter = {
      ...baseLlm,
      getConfiguredTier: () => 'small',
      resolve: vi.fn(() => ({ model: 'vision-model', actualTier: 'small' })),
      resolveAdapter: vi.fn(async () => ({
        model: 'vision-model',
        tier: 'small',
        adapter: underlyingAdapter,
      })),
      hasCapability: vi.fn(() => true),
      getCapabilities: vi.fn(() => ['vision']),
      supportsCapabilities: vi.fn(() => true),
    };
    const underlyingAdapter = { ...baseLlm };
    const wrapped = wrapLlm(adapter, makeCtx({ llm: true })) as ILLM & ILLMRouter;

    expect(wrapped.getConfiguredTier()).toBe('small');
    expect(wrapped.supportsCapabilities({ tier: 'small', capabilities: ['vision'] })).toBe(true);
    expect(wrapped.getCapabilities()).toEqual(['vision']);
    const binding = await wrapped.resolveAdapter({ tier: 'small', capabilities: ['vision'] });
    expect(binding.model).toBe('vision-model');
    expect(binding.adapter).not.toBe(underlyingAdapter);
    expect(adapter.supportsCapabilities).toHaveBeenCalledWith({ tier: 'small', capabilities: ['vision'] });
  });

  it('stream also enforces model allowlist', async () => {
    const adapter = { ...baseLlm };
    const wrapped = wrapLlm(adapter, makeCtx({ llm: { models: ['gpt-4o-mini'] } }));
    const iter = wrapped.stream('p', { model: 'forbidden' } as never)[Symbol.asyncIterator]();
    await expect(iter.next()).rejects.toThrow(PermissionError);
  });
});

// ─── wrapCache ───────────────────────────────────────────────────────────────

describe('wrapCache', () => {
  const base = {
    get: vi.fn(async () => null),
    set: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
    zadd: vi.fn(async () => {}),
    zrangebyscore: vi.fn(async () => []),
    zrem: vi.fn(async () => {}),
    setIfNotExists: vi.fn(async () => true),
  };

  it('denies all methods when no cache permission', () => {
    const wrapped = wrapCache(base, makeCtx({}));
    // createDeniedService proxy throws synchronously on property access
    expect(() => wrapped.get).toThrow(PermissionError);
  });

  it('allows all keys when permission is true', async () => {
    const adapter = { ...base, get: vi.fn().mockResolvedValue('v') };
    const wrapped = wrapCache(adapter, makeCtx({ cache: true }));
    await expect(wrapped.get('any-key')).resolves.toBe('v');
  });

  it('enforces namespace prefix on get', async () => {
    const wrapped = wrapCache(base, makeCtx({ cache: { namespaces: ['ns:'] } }));
    await expect(wrapped.get('other:key')).rejects.toThrow(PermissionError);
    await expect(wrapped.get('ns:key')).resolves.toBeNull();
  });

  it('enforces namespace prefix on set', async () => {
    const adapter = { ...base, set: vi.fn(async () => {}) };
    const wrapped = wrapCache(adapter, makeCtx({ cache: { namespaces: ['ns:'] } }));
    await expect(wrapped.set('bad:key', 'v')).rejects.toThrow(PermissionError);
    await wrapped.set('ns:key', 'v');
    expect(adapter.set).toHaveBeenCalledWith('ns:key', 'v', undefined);
  });

  it('enforces namespace prefix on delete', async () => {
    const wrapped = wrapCache(base, makeCtx({ cache: { namespaces: ['ns:'] } }));
    await expect(wrapped.delete('other:key')).rejects.toThrow(PermissionError);
  });

  it('enforces namespace prefix on zadd', async () => {
    const wrapped = wrapCache(base, makeCtx({ cache: { namespaces: ['ns:'] } }));
    await expect(wrapped.zadd('bad:set', 1, 'member')).rejects.toThrow(PermissionError);
  });

  it('enforces namespace prefix on zrangebyscore', async () => {
    const wrapped = wrapCache(base, makeCtx({ cache: { namespaces: ['ns:'] } }));
    await expect(wrapped.zrangebyscore('bad:set', 0, 10)).rejects.toThrow(PermissionError);
  });

  it('enforces namespace prefix on zrem', async () => {
    const wrapped = wrapCache(base, makeCtx({ cache: { namespaces: ['ns:'] } }));
    await expect(wrapped.zrem('bad:set', 'member')).rejects.toThrow(PermissionError);
  });

  it('enforces namespace prefix on setIfNotExists', async () => {
    const wrapped = wrapCache(base, makeCtx({ cache: { namespaces: ['ns:'] } }));
    await expect(wrapped.setIfNotExists('bad:key', 'v')).rejects.toThrow(PermissionError);
  });

  it('clear() requires full permission (true), denies on namespace-scoped', async () => {
    const wrapped = wrapCache(base, makeCtx({ cache: { namespaces: ['ns:'] } }));
    await expect(wrapped.clear()).rejects.toThrow(PermissionError);
  });

  it('clear() allowed when permission is true', async () => {
    const adapter = { ...base, clear: vi.fn(async () => {}) };
    const wrapped = wrapCache(adapter, makeCtx({ cache: true }));
    await wrapped.clear();
    expect(adapter.clear).toHaveBeenCalled();
  });
});

// ─── wrapStorage ─────────────────────────────────────────────────────────────

describe('wrapStorage', () => {
  const base = {
    read: vi.fn(async () => Buffer.from('data')),
    write: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    exists: vi.fn(async () => true),
    list: vi.fn(async () => []),
  };

  it('denies all methods when no storage permission', () => {
    const wrapped = wrapStorage(base, makeCtx({}));
    expect(() => wrapped.read).toThrow(PermissionError);
  });

  it('allows all paths when permission is true', async () => {
    const adapter = { ...base, read: vi.fn(async () => Buffer.from('x')) };
    const wrapped = wrapStorage(adapter, makeCtx({ storage: true }));
    await expect(wrapped.read('/any/path')).resolves.toBeDefined();
  });

  it('enforces path restriction on read', async () => {
    const wrapped = wrapStorage(base, makeCtx({ storage: { paths: ['/allowed/'] } }));
    await expect(wrapped.read('/forbidden/file')).rejects.toThrow(PermissionError);
    await expect(wrapped.read('/allowed/file')).resolves.toBeDefined();
  });

  it('enforces path restriction on write', async () => {
    const adapter = { ...base, write: vi.fn(async () => {}) };
    const wrapped = wrapStorage(adapter, makeCtx({ storage: { paths: ['/allowed/'] } }));
    await expect(wrapped.write('/other/file', Buffer.from('x'))).rejects.toThrow(PermissionError);
    await wrapped.write('/allowed/file', Buffer.from('x'));
    expect(adapter.write).toHaveBeenCalled();
  });

  it('enforces path restriction on delete', async () => {
    const wrapped = wrapStorage(base, makeCtx({ storage: { paths: ['/allowed/'] } }));
    await expect(wrapped.delete('/other/file')).rejects.toThrow(PermissionError);
  });

  it('enforces path restriction on exists', async () => {
    const wrapped = wrapStorage(base, makeCtx({ storage: { paths: ['/allowed/'] } }));
    await expect(wrapped.exists('/bad/path')).rejects.toThrow(PermissionError);
  });

  it('enforces path restriction on list', async () => {
    const wrapped = wrapStorage(base, makeCtx({ storage: { paths: ['/allowed/'] } }));
    await expect(wrapped.list('/other/')).rejects.toThrow(PermissionError);
  });
});

// ─── wrapVectorStore ─────────────────────────────────────────────────────────

describe('wrapVectorStore', () => {
  const base = {
    search: vi.fn(async () => []),
    upsert: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    count: vi.fn(async () => 0),
  };

  it('denies all methods when no vectorStore permission', () => {
    const wrapped = wrapVectorStore(base, makeCtx({}));
    expect(() => wrapped.search).toThrow(PermissionError);
  });

  it('allows all operations when permission is true', async () => {
    const adapter = { ...base, search: vi.fn(async () => [{ id: '1', score: 0.9 }]) };
    const wrapped = wrapVectorStore(adapter, makeCtx({ vectorStore: true }));
    const results = await wrapped.search([0.1, 0.2], 5);
    expect(results).toHaveLength(1);
  });

  it('prefixes vector ids on upsert when namespace is set', async () => {
    const adapter = { ...base, upsert: vi.fn(async () => {}) };
    const wrapped = wrapVectorStore(adapter, makeCtx({ vectorStore: { collections: ['ns'] } }));
    await wrapped.upsert([{ id: 'doc-1', vector: [0.1], metadata: {} }]);
    const call = (adapter.upsert as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call[0].id).toMatch(/^ns/);
    expect(call[0].metadata._kbNamespace).toBe('ns');
  });

  it('does not double-prefix ids that already start with namespace', async () => {
    const adapter = { ...base, upsert: vi.fn(async () => {}) };
    const wrapped = wrapVectorStore(adapter, makeCtx({ vectorStore: { collections: ['ns'] } }));
    await wrapped.upsert([{ id: 'nsdoc-1', vector: [0.1], metadata: {} }]);
    const call = (adapter.upsert as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call[0].id).not.toMatch(/^nsns/);
  });

  it('filters search results by namespace metadata and strips the id prefix', async () => {
    const adapter = {
      ...base,
      search: vi.fn(async () => [
        { id: 'nsdoc-1', score: 0.9, metadata: { _kbNamespace: 'ns' } },
        { id: 'otherdoc-1', score: 0.8, metadata: { _kbNamespace: 'other' } },
        { id: 'nsdoc-2', score: 0.7, metadata: {} }, // no namespace tag → passes through
      ]),
    };
    const wrapped = wrapVectorStore(adapter, makeCtx({ vectorStore: { collections: ['ns'] } }));
    const results = await wrapped.search([0.1], 10);
    // 'otherdoc-1' is filtered (wrong namespace); the surviving ids have the
    // 'ns' prefix STRIPPED so they round-trip to what the caller upserted.
    expect(results.map((r: any) => r.id)).toEqual(['doc-1', 'doc-2']);
  });

  it('round-trips upserted ids through search (prefix added then stripped)', async () => {
    // The regression: vector ids must survive a write→read cycle unchanged, or
    // consumers fusing hits back to their records (mind's retrieve) drop them all.
    const store: Array<{ id: string; score: number; metadata: Record<string, unknown> }> = [];
    const adapter = {
      ...base,
      upsert: vi.fn(async (vectors: Array<{ id: string; metadata?: Record<string, unknown> }>) => {
        for (const v of vectors) {
          store.push({ id: v.id, score: 0.9, metadata: v.metadata ?? {} });
        }
      }),
      search: vi.fn(async () => store),
    };
    const wrapped = wrapVectorStore(adapter, makeCtx({ vectorStore: { collections: ['mind:'] } }));
    const originalId = 'src/Feature/Service.cs#10-42';
    await wrapped.upsert([{ id: originalId, vector: [0.1], metadata: {} }]);
    const results = await wrapped.search([0.1], 5);
    expect(results[0]?.id).toBe(originalId);
  });

  it('does not filter when permission is true (no namespace)', async () => {
    const adapter = {
      ...base,
      search: vi.fn(async () => [
        { id: '1', score: 0.9, metadata: { _kbNamespace: 'ns' } },
        { id: '2', score: 0.8, metadata: {} },
      ]),
    };
    const wrapped = wrapVectorStore(adapter, makeCtx({ vectorStore: true }));
    const results = await wrapped.search([0.1], 10);
    expect(results).toHaveLength(2);
  });
});

// ─── wrapEmbeddings ───────────────────────────────────────────────────────────

describe('wrapEmbeddings', () => {
  const base = {
    embed: vi.fn(async () => [0.1, 0.2]),
    embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [0.1])),
    dimensions: 1536,
    getDimensions: vi.fn(async () => 1536),
  };

  it('denies when no embeddings permission', () => {
    const wrapped = wrapEmbeddings(base, makeCtx({}));
    expect(() => wrapped.embed).toThrow(PermissionError);
  });

  it('allows embed when permission is true', async () => {
    const adapter = { ...base, embed: vi.fn(async () => [0.1]) };
    const wrapped = wrapEmbeddings(adapter, makeCtx({ embeddings: true }));
    await wrapped.embed('hello');
    expect(adapter.embed).toHaveBeenCalledWith('hello');
  });

  it('allows embedBatch when permission is true', async () => {
    const adapter = { ...base, embedBatch: vi.fn(async () => [[0.1]]) };
    const wrapped = wrapEmbeddings(adapter, makeCtx({ embeddings: true }));
    await wrapped.embedBatch(['a', 'b']);
    expect(adapter.embedBatch).toHaveBeenCalledWith(['a', 'b']);
  });
});

// ─── wrapNotifier ─────────────────────────────────────────────────────────────

describe('wrapNotifier', () => {
  const base = {
    notify: vi.fn(async () => {}),
    subscribe: vi.fn(() => () => {}),
  };

  it('denies notify and subscribe when no notifier permission', () => {
    const wrapped = wrapNotifier(base, makeCtx({}));
    // createDeniedService proxy throws synchronously on property access
    expect(() => wrapped.notify).toThrow(PermissionError);
  });

  it('denies notify when emit is false', async () => {
    const wrapped = wrapNotifier(base, makeCtx({ notifier: { emit: false } }));
    await expect(wrapped.notify({ title: 'x' } as never)).rejects.toThrow(PermissionError);
  });

  it('allows notify when emit is true, stamps source as pluginId', async () => {
    const adapter = { ...base, notify: vi.fn(async () => {}) };
    const wrapped = wrapNotifier(adapter, makeCtx({ notifier: { emit: true } }));
    await wrapped.notify({ title: 'alert', severity: 'warning' } as never);
    const call = (adapter.notify as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.source).toBe('test-plugin');
  });

  it('denies subscribe when no subscribe permission', () => {
    const wrapped = wrapNotifier(base, makeCtx({ notifier: { emit: true } }));
    expect(() => wrapped.subscribe({} as never, vi.fn())).toThrow(PermissionError);
  });

  it('filters events by allowed source', async () => {
    const adapter = {
      ...base,
      subscribe: vi.fn((filter: unknown, handler: (e: unknown) => Promise<void>) => {
        // Immediately deliver two events — one from allowed source, one not
        setTimeout(async () => {
          await handler({ source: 'allowed-plugin', severity: 'info' });
          await handler({ source: 'other-plugin', severity: 'info' });
        }, 0);
        return () => {};
      }),
    };
    const wrapped = wrapNotifier(adapter, makeCtx({
      notifier: { subscribe: { sources: ['allowed-plugin'], severity: ['info'] } },
    }));

    const received: unknown[] = [];
    wrapped.subscribe({} as never, async (e) => { received.push(e); });
    await new Promise<void>(r => { setTimeout(r, 20); });
    expect(received).toHaveLength(1);
    expect((received[0] as any).source).toBe('allowed-plugin');
  });

  it('allows all sources when sources contains wildcard', async () => {
    const adapter = {
      ...base,
      subscribe: vi.fn((_filter: unknown, handler: (e: unknown) => Promise<void>) => {
        setTimeout(async () => {
          await handler({ source: 'any-plugin', severity: 'info' });
          await handler({ source: 'another', severity: 'warning' });
        }, 0);
        return () => {};
      }),
    };
    const wrapped = wrapNotifier(adapter, makeCtx({
      notifier: { subscribe: { sources: ['*'] } },
    }));

    const received: unknown[] = [];
    wrapped.subscribe({} as never, async (e) => { received.push(e); });
    await new Promise<void>(r => { setTimeout(r, 20); });
    expect(received).toHaveLength(2);
  });
});
