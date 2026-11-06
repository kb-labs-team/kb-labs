/**
 * @module @kb-labs/adapters-sqlite
 *
 * SQLite-backed `IDocumentDatabase`.
 *
 * The `IKVStore` companion lives at the `./kv` subpath. Both adapters use
 * `acquireHandle` under the hood, so registering them against the same
 * `filename` produces a single `better-sqlite3` connection — one WAL, one
 * sweeper, no inter-adapter contention.
 *
 * Plugins never see `ISQLDatabase`. The legacy single-adapter / raw-SQL
 * path was intentionally retired: storage abstractions in KB Labs are
 * defined by access pattern, not by query language.
 */

import {
  SqliteDocumentDatabase,
  createSqliteDocumentDatabase,
  type SqliteDocumentConfig,
} from './document-database.js';
import {
  SqliteKVStore,
  createSqliteKVStore,
  type SqliteKVConfig,
} from './kv-store.js';

export {
  SqliteDocumentDatabase,
  createSqliteDocumentDatabase,
  type SqliteDocumentConfig,
  SqliteKVStore,
  createSqliteKVStore,
  type SqliteKVConfig,
};

export { manifest } from './manifest.js';
export { SqliteVectorStore, createSqliteVectorStore, type SqliteVectorStoreConfig } from './vector-store.js';

/**
 * Platform factory — called by the adapter loader when this module is
 * registered against the `documentDatabase` slot.
 */
export function createAdapter(config: SqliteDocumentConfig): SqliteDocumentDatabase {
  return createSqliteDocumentDatabase(config);
}

export default createAdapter;
