import { COLLECTIONS } from '../../contracts/index.js';
import { getDb } from '../db.js';
import { appendEvent } from './event.js';

export interface Snapshot {
  exportedAt: number;
  collections: Record<string, unknown[]>;
}

/**
 * Dumps every collection to plain objects for the daily backup artifact.
 * Writing the result to disk and pushing it to the private repo is a job
 * concern (`entry/src/jobs/export-backup.ts`), not core's — core only
 * produces the data (ADR-0001 §Бэкапы, §"Разделение core/entry").
 */
export async function exportSnapshot(): Promise<Snapshot> {
  const docs = await getDb();
  const collections: Record<string, unknown[]> = {};
  for (const name of Object.values(COLLECTIONS)) {
    collections[name] = await docs.find(name, {});
  }

  const snapshot: Snapshot = { exportedAt: Date.now(), collections };

  await appendEvent({
    subjectType: 'project',
    subjectId: 'global',
    kind: 'export.completed',
    meta: { counts: Object.fromEntries(Object.entries(collections).map(([k, v]) => [k, v.length])) },
  });

  return snapshot;
}
