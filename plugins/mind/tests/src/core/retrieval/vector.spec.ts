import { describe, expect, it, vi } from 'vitest';
import type { IVectorStore, VectorRecord } from '@kb-labs/sdk/adapters';
import { vectorSearch } from '../../../../src/core/retrieval/vector.js';

function vectorStore(count: () => Promise<number>): IVectorStore {
  return {
    search: vi.fn(async () => []),
    upsert: vi.fn(async (_vectors: VectorRecord[]) => {}),
    delete: vi.fn(async (_ids: string[]) => {}),
    count: vi.fn(count),
  };
}

describe('vectorSearch', () => {
  it('checks the vector capability before embedding and preserves its typed unavailable error', async () => {
    const missing = Object.assign(new Error('vectorStore is not configured'), {
      name: 'AdapterUnavailableError',
      slot: 'vectorStore',
      reason: 'not-configured',
    });
    const store = vectorStore(async () => { throw missing; });
    const embed = vi.fn(async () => [0.1, 0.2]);

    await expect(vectorSearch('query', store, embed, 'code', 10)).rejects.toBe(missing);
    expect(embed).not.toHaveBeenCalled();
  });

  it('skips embedding when the local vector namespace is empty', async () => {
    const store = vectorStore(async () => 0);
    const embed = vi.fn(async () => [0.1, 0.2]);

    await expect(vectorSearch('query', store, embed, 'code', 10)).resolves.toEqual([]);
    expect(embed).not.toHaveBeenCalled();
    expect(store.search).not.toHaveBeenCalled();
  });
});
