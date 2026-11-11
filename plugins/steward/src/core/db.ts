import { useDocumentDatabase } from '@kb-labs/sdk';
import type { IDocumentDatabase } from '@kb-labs/sdk';
import { COLLECTIONS } from '../contracts/index.js';

/**
 * Resolves the plugin's document database and ensures collections/indexes
 * exist. Idempotent — safe to call from every command handler.
 */
export async function getDb(): Promise<IDocumentDatabase> {
  const docs = useDocumentDatabase();
  if (!docs) {
    throw new Error(
      'steward requires a documentDatabase adapter — none is configured on this platform',
    );
  }
  await ensureCollections(docs);
  return docs;
}

let ensured = false;

async function ensureCollections(docs: IDocumentDatabase): Promise<void> {
  if (ensured) {return;}
  await Promise.all([
    docs.ensureCollection(COLLECTIONS.projects, {
      indexes: [{ path: 'name' }, { path: 'status' }],
    }),
    docs.ensureCollection(COLLECTIONS.resources, {
      indexes: [{ path: 'projectId' }],
    }),
    docs.ensureCollection(COLLECTIONS.people, {
      indexes: [{ path: 'name' }, { path: 'companyId' }],
    }),
    docs.ensureCollection(COLLECTIONS.companies, {
      indexes: [{ path: 'name' }],
    }),
    docs.ensureCollection(COLLECTIONS.projectMembers, {
      indexes: [{ path: ['personId', 'projectId'] }],
    }),
    docs.ensureCollection(COLLECTIONS.commitments, {
      indexes: [{ path: ['status', 'remindAt'] }, { path: 'projectId' }, { path: 'personId' }],
    }),
    docs.ensureCollection(COLLECTIONS.events, {
      indexes: [{ path: ['subjectType', 'subjectId', 'at'] }, { path: 'kind' }],
    }),
    docs.ensureCollection(COLLECTIONS.topics, {
      indexes: [{ path: 'name' }],
    }),
  ]);
  ensured = true;
}
