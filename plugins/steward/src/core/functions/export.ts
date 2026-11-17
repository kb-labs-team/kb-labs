import { COLLECTIONS } from '../../contracts/index.js';
import { getDb } from '../db.js';
import { appendEvent } from './event.js';

export interface Snapshot {
  exportedAt: number;
  collections: Record<string, unknown[]>;
}

/**
 * Dumps every collection to plain objects for the daily storage object.
 * Persistence is a job concern; the successful-export event is recorded only
 * after the storage write completes.
 */
export async function exportSnapshot(): Promise<Snapshot> {
  const docs = await getDb();
  const collections: Record<string, unknown[]> = {};
  for (const name of Object.values(COLLECTIONS)) {
    collections[name] = await docs.find(name, {});
  }

  const snapshot: Snapshot = { exportedAt: Date.now(), collections };

  return snapshot;
}

export async function recordExportCompleted(snapshot: Snapshot): Promise<void> {
  await appendEvent({
    subjectType: 'project',
    subjectId: 'global',
    kind: 'export.completed',
    meta: { counts: Object.fromEntries(Object.entries(snapshot.collections).map(([k, v]) => [k, v.length])) },
  });
}
