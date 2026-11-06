/**
 * Vector retrieval via the platform vector store, scoped by namespace=indexId.
 */

import type { IVectorStore } from '../services';
import type { Ranked } from './bm25';

function isAdapterUnavailableError(error: unknown): error is Error {
  return error instanceof Error && error.name === 'AdapterUnavailableError';
}

export async function vectorSearch(
  queryText: string,
  vectorStore: IVectorStore,
  embed: (text: string) => Promise<number[]>,
  indexId: string,
  limit: number,
): Promise<Ranked[]> {
  let count: number;
  try {
    count = await vectorStore.count(indexId);
  } catch (err) {
    if (isAdapterUnavailableError(err)) { throw err; }
    throw new Error(`mind: vector store availability check failed (indexId="${indexId}") — ${err instanceof Error ? err.message : String(err)}`);
  }
  if (count === 0) { return []; }

  let vector: number[];
  try {
    vector = await embed(queryText);
  } catch (err) {
    if (isAdapterUnavailableError(err)) { throw err; }
    throw new Error(`mind: query embedding failed — ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const hits = await vectorStore.search(vector, limit, undefined, indexId);
    return hits.map((h) => ({ id: h.id, score: h.score }));
  } catch (err) {
    if (isAdapterUnavailableError(err)) { throw err; }
    throw new Error(
      `mind: vector search failed (indexId="${indexId}", dims=${vector.length}) — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
