/**
 * Auto-index job: rebuild an index on a schedule.
 *
 * Reusable background handler — wire it to a scheduler/cron as needed. Kept
 * thin: it just drives the same `reindex` verb the CLI/REST use.
 */

import { buildMind } from '../platform';
import type { IndexResponse } from '../contracts/index.js';

export interface AutoIndexOptions {
  indexId?: string;
  full?: boolean;
}

export async function runAutoIndex(opts: AutoIndexOptions = {}): Promise<IndexResponse> {
  const mind = await buildMind();
  return mind.reindex({ indexId: opts.indexId, full: opts.full ?? true });
}

export default runAutoIndex;
