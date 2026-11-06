import { describe, it, expect, vi } from 'vitest';
import { createMind } from '../../../src/core/mind';
import type { MindServices } from '../../../src/core/services';
import { resolveMindConfig } from '@kb-labs/mind/contracts';

/**
 * Regression: `mind index delete` must not report success for a no-op on a missing or
 * mis-typed index id (loadManifest returns an empty manifest when absent, which
 * previously made drop print "removed 0 vectors" with exit 0 on the wrong id).
 */
function servicesWith(manifests: Record<string, unknown>) {
  const store = new Map<string, Buffer>();
  for (const [id, m] of Object.entries(manifests)) {
    store.set(`mind/${id}/manifest.json`, Buffer.from(JSON.stringify(m), 'utf8'));
  }
  const vectorStore = { delete: vi.fn(async () => {}) };
  const storage = {
    read: vi.fn(async (key: string) => store.get(key) ?? null),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
  return { services: { vectorStore, storage } as unknown as MindServices, vectorStore, storage };
}

describe('mind index delete — missing index guard', () => {
  it('throws for an index that has no manifest (does not fake success)', async () => {
    const { services, vectorStore, storage } = servicesWith({});
    const mind = createMind(services, resolveMindConfig(undefined));
    await expect(mind.drop({ indexId: 'typo' })).rejects.toThrow(/No such index "typo"/);
    expect(vectorStore.delete).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('drops vectors + manifest for an existing index', async () => {
    const manifest = {
      indexId: 'code',
      chunks: [{ id: 'a' }, { id: 'b' }],
      files: { 'src/x.ts': { hash: 'h' } },
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const { services, vectorStore, storage } = servicesWith({ code: manifest });
    const mind = createMind(services, resolveMindConfig(undefined));
    const res = await mind.drop({ indexId: 'code' });
    expect(res).toEqual({ indexId: 'code', droppedChunks: 2, droppedFiles: 1 });
    expect(vectorStore.delete).toHaveBeenCalledWith(['a', 'b'], 'code');
    expect(storage.delete).toHaveBeenCalledWith('mind/code/manifest.json');
  });
});
