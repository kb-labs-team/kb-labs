import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteVectorStore } from './vector-store.js';
import { manifest } from './manifest.js';

describe('SQLite vector store', () => {
  const directories: string[] = [];
  const stores: SqliteVectorStore[] = [];

  afterEach(async () => {
    for (const store of stores.splice(0)) {
      store.close();
    }
    for (const directory of directories.splice(0)) {
      await rm(directory, { recursive: true, force: true });
    }
  });

  async function createStore(directory?: string): Promise<SqliteVectorStore> {
    const databaseDirectory = directory ?? await mkdtemp(join(tmpdir(), 'kb-sqlite-vectors-'));
    if (directory === undefined) {
      directories.push(databaseDirectory);
    }
    const store = new SqliteVectorStore({ filename: join(databaseDirectory, 'vectors.sqlite') });
    stores.push(store);
    return store;
  }

  // case: S-054.25
  it('persists records, original IDs, namespaces, metadata filters, and cosine rankings', async () => {
    const first = await createStore();
    await first.upsert([
      { id: 'doc-1', vector: [1, 0], metadata: { group: 'docs', rank: 2 } },
      { id: 'doc-2', vector: [0, 1], metadata: { group: 'other', rank: 1 } },
    ], 'project');

    expect(await first.count('project')).toBe(2);
    expect(await first.search([0.8, 0.2], 2, { field: 'group', operator: 'eq', value: 'docs' }, 'project'))
      .toEqual([{ id: 'doc-1', score: expect.closeTo(0.97014, 4), metadata: { group: 'docs', rank: 2 } }]);

    first.close();
    stores.splice(stores.indexOf(first), 1);
    const reopened = await createStore(directories[0]);
    expect(await reopened.get(['doc-1'], 'project')).toEqual([
      { id: 'doc-1', vector: [1, 0], metadata: { group: 'docs', rank: 2 } },
    ]);
    expect(await reopened.search([1, 0], 1, undefined, 'project')).toEqual([
      { id: 'doc-1', score: 1, metadata: { group: 'docs', rank: 2 } },
    ]);
  });

  // case: S-281.4
  it('breaks equal cosine scores by stable record ID in ascending order', async () => {
    const store = await createStore();
    await store.upsert([
      { id: 'z-last', vector: [1, 0] },
      { id: 'a-first', vector: [1, 0] },
    ]);

    expect(await store.search([1, 0], 2)).toEqual([
      { id: 'a-first', score: 1 },
      { id: 'z-last', score: 1 },
    ]);
  });

  // case: S-054.1
  it('registers the SQLite package as the vectorStore catalogue default', () => {
    expect(manifest.defaultFor?.vectorStore).toEqual(['vector-store']);
    expect(manifest.configSchema?.vectorFilename).toMatchObject({
      defaultPath: { root: 'projectState', segments: ['vector-store', 'vectors.sqlite'] },
    });
  });

  // case: S-281.1
  it('rejects empty, non-finite, and zero-magnitude vectors before storing them', async () => {
    const store = await createStore();
    const invalidVectors = [[], [Number.NaN], [Number.POSITIVE_INFINITY], [0, 0]];

    for (const [index, vector] of invalidVectors.entries()) {
      await expect(store.upsert([{ id: `invalid-${index}`, vector }])).rejects.toMatchObject({
        code: 'KB_RUNTIME_INPUT_INVALID', details: { field: 'vector' },
      });
    }
    expect(await store.count()).toBe(0);
  });

  // case: S-281.2
  it('rejects invalid and dimension-mismatched search queries', async () => {
    const store = await createStore();
    await store.upsert([{ id: 'valid', vector: [1, 0] }]);

    for (const query of [[], [Number.NaN], [Number.NEGATIVE_INFINITY], [0, 0], [1]]) {
      await expect(store.search(query, 10)).rejects.toMatchObject({
        code: 'KB_RUNTIME_INPUT_INVALID', details: { field: 'vector' },
      });
    }
    expect(await store.search([1, 0], 10)).toEqual([{ id: 'valid', score: 1 }]);
  });

  // case: S-281.3
  it('rejects mixed dimensions without writing any record from the batch', async () => {
    const store = await createStore();

    await expect(store.upsert([
      { id: 'dimension-2', vector: [1, 0] },
      { id: 'dimension-3', vector: [1, 0, 0] },
    ])).rejects.toMatchObject({ code: 'KB_RUNTIME_INPUT_INVALID', details: { field: 'vector' } });
    expect(await store.count()).toBe(0);

    await store.upsert([{ id: 'existing-dimension-2', vector: [0, 1] }], 'existing');
    await expect(store.upsert([
      { id: 'new-dimension-3', vector: [1, 0, 0] },
    ], 'existing')).rejects.toMatchObject({ code: 'KB_RUNTIME_INPUT_INVALID', details: { field: 'vector' } });
    expect(await store.count('existing')).toBe(1);
  });
});
