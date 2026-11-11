/**
 * Query-history feedback loop via the platform cache (sorted set).
 *
 * Records queries per index (scored by timestamp) so the engine can learn from
 * usage over time. Best-effort: cache failures never break a query.
 */

import type { ICache } from '../services';
import { MIND_NAMESPACE_PREFIX } from '../../contracts/index.js';

function historyKey(indexId: string): string {
  return `${MIND_NAMESPACE_PREFIX}history:${indexId}`;
}

export async function recordQuery(
  cache: ICache,
  indexId: string,
  query: string,
  at: number,
): Promise<void> {
  try {
    await cache.zadd(historyKey(indexId), at, query);
  } catch {
    // Feedback is best-effort; never fail the user's query because of it.
  }
}

export async function recentQueries(
  cache: ICache,
  indexId: string,
  sinceMs = 0,
): Promise<string[]> {
  try {
    return await cache.zrangebyscore(historyKey(indexId), sinceMs, Number.MAX_SAFE_INTEGER);
  } catch {
    return [];
  }
}
