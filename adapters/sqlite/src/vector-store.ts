/**
 * SQLite-backed vector store for small, local semantic indexes.
 */

import type Database from 'better-sqlite3';
import type {
  IVectorStore,
  PlatformDataContext,
  VectorFilter,
  VectorRecord,
  VectorSearchResult,
} from '@kb-labs/sdk/adapters';
import { acquireHandle, type SharedHandle } from './shared-handle.js';

const TABLE = '_kb_vectors';

class InvalidVectorInputError extends TypeError {
  readonly code = 'KB_RUNTIME_INPUT_INVALID';
  readonly details: { field: string };

  constructor(field: string, message: string) {
    super(message);
    this.name = 'InvalidVectorInputError';
    this.details = { field };
  }
}

export interface SqliteVectorStoreConfig {
  /** SQLite file path. */
  filename: string;
  readonly?: boolean;
  wal?: boolean;
}

export class SqliteVectorStore implements IVectorStore {
  private readonly db: Database.Database;
  private readonly handle: SharedHandle;
  private closed = false;

  constructor(config: SqliteVectorStoreConfig) {
    this.handle = acquireHandle(config);
    this.db = this.handle.handle;
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS ${TABLE} (
        namespace TEXT NOT NULL,
        id TEXT NOT NULL,
        vector TEXT NOT NULL,
        metadata TEXT,
        PRIMARY KEY (namespace, id)
      ) STRICT`,
    );
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_${TABLE}_namespace ON ${TABLE}(namespace)`);
  }

  async search(
    query: number[],
    limit: number,
    filter?: VectorFilter,
    namespace?: string,
  ): Promise<VectorSearchResult[]> {
    this.checkOpen();
    validateVector(query, 'query');
    const rows = this.db.prepare(
      `SELECT id, vector, metadata FROM ${TABLE} WHERE namespace = ?`,
    ).all(namespace ?? '') as Array<{ id: string; vector: string; metadata: string | null }>;
    const records = rows.map((row) => {
      const vector = JSON.parse(row.vector) as number[];
      validateVector(vector, `stored vector ${row.id}`);
      if (vector.length !== query.length) {
        throw new InvalidVectorInputError('vector', `query dimensions do not match stored vector ${row.id}`);
      }
      return {
        id: row.id,
        vector,
        metadata: row.metadata === null ? undefined : JSON.parse(row.metadata) as Record<string, unknown>,
      };
    });
    return records
      .filter((record) => !filter || matchesFilter(record.metadata, filter))
      .map((record) => ({
        id: record.id,
        score: cosineSimilarity(query, record.vector),
        ...(record.metadata === undefined ? {} : { metadata: record.metadata }),
      }))
      .sort((left, right) => right.score - left.score || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
      .slice(0, limit);
  }

  async upsert(vectors: VectorRecord[], namespace?: string): Promise<void> {
    this.checkOpen();
    for (const record of vectors) {
      validateVector(record.vector, `record ${record.id}`);
    }
    const dimensions = new Set(vectors.map(({ vector }) => vector.length));
    if (dimensions.size > 1) {
      throw new InvalidVectorInputError('vector', 'vectors in one namespace must have matching dimensions');
    }
    const batchDimensions = dimensions.values().next().value as number | undefined;
    if (batchDimensions !== undefined) {
      const existingRows = this.db.prepare(
        `SELECT id, vector FROM ${TABLE} WHERE namespace = ?`,
      ).all(namespace ?? '') as Array<{ id: string; vector: string }>;
      for (const row of existingRows) {
        const vector = JSON.parse(row.vector) as number[];
        validateVector(vector, `stored vector ${row.id}`);
        if (vector.length !== batchDimensions) {
          throw new InvalidVectorInputError('vector', `dimensions do not match stored vector ${row.id}`);
        }
      }
    }
    const insert = this.db.prepare(
      `INSERT INTO ${TABLE} (namespace, id, vector, metadata)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(namespace, id) DO UPDATE SET
         vector = excluded.vector,
         metadata = excluded.metadata`,
    );
    const upsert = this.db.transaction((records: VectorRecord[]) => {
      for (const record of records) {
        insert.run(namespace ?? '', record.id, JSON.stringify(record.vector),
          record.metadata === undefined ? null : JSON.stringify(record.metadata));
      }
    });
    upsert(vectors);
  }

  async delete(ids: string[], namespace?: string): Promise<void> {
    this.checkOpen();
    const remove = this.db.prepare(`DELETE FROM ${TABLE} WHERE namespace = ? AND id = ?`);
    const deletion = this.db.transaction((recordIds: string[]) => {
      for (const id of recordIds) {
        remove.run(namespace ?? '', id);
      }
    });
    deletion(ids);
  }

  async count(namespace?: string): Promise<number> {
    this.checkOpen();
    const row = this.db.prepare(
      `SELECT COUNT(*) AS total FROM ${TABLE} WHERE namespace = ?`,
    ).get(namespace ?? '') as { total: number };
    return row.total;
  }

  async get(ids: string[], namespace?: string): Promise<VectorRecord[]> {
    this.checkOpen();
    const find = this.db.prepare(
      `SELECT id, vector, metadata FROM ${TABLE} WHERE namespace = ? AND id = ?`,
    );
    return ids.flatMap((id) => {
      const row = find.get(namespace ?? '', id) as
        { id: string; vector: string; metadata: string | null } | undefined;
      return row ? [{
        id: row.id,
        vector: JSON.parse(row.vector) as number[],
        ...(row.metadata === null ? {} : { metadata: JSON.parse(row.metadata) as Record<string, unknown> }),
      }] : [];
    });
  }

  async query(filter: VectorFilter, namespace?: string): Promise<VectorRecord[]> {
    this.checkOpen();
    const rows = this.db.prepare(
      `SELECT id, vector, metadata FROM ${TABLE} WHERE namespace = ?`,
    ).all(namespace ?? '') as Array<{ id: string; vector: string; metadata: string | null }>;
    return rows.flatMap((row) => {
      const metadata = row.metadata === null ? undefined : JSON.parse(row.metadata) as Record<string, unknown>;
      if (!matchesFilter(metadata, filter)) {
        return [];
      }
      return [{
        id: row.id,
        vector: JSON.parse(row.vector) as number[],
        ...(metadata === undefined ? {} : { metadata }),
      }];
    });
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.handle.release();
  }

  private checkOpen(): void {
    if (this.closed) {
      throw new Error('SQLite vector store is closed');
    }
  }
}

function cosineSimilarity(left: number[], right: number[]): number {
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index++) {
    const a = left[index]!;
    const b = right[index]!;
    dot += a * b;
    leftMagnitude += a * a;
    rightMagnitude += b * b;
  }
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

function validateVector(vector: number[], label: string): void {
  if (vector.length === 0 || !vector.every(Number.isFinite)) {
    throw new InvalidVectorInputError('vector', `${label} must contain finite numbers and cannot be empty`);
  }
  if (vector.every((component) => component === 0)) {
    throw new InvalidVectorInputError('vector', `${label} must have non-zero magnitude`);
  }
}

function matchesFilter(metadata: Record<string, unknown> | undefined, filter: VectorFilter): boolean {
  const actual = metadata?.[filter.field];
  switch (filter.operator) {
    case 'eq': return actual === filter.value;
    case 'ne': return actual !== filter.value;
    case 'gt': return typeof actual === 'number' && typeof filter.value === 'number' && actual > filter.value;
    case 'gte': return typeof actual === 'number' && typeof filter.value === 'number' && actual >= filter.value;
    case 'lt': return typeof actual === 'number' && typeof filter.value === 'number' && actual < filter.value;
    case 'lte': return typeof actual === 'number' && typeof filter.value === 'number' && actual <= filter.value;
    case 'in': return Array.isArray(filter.value) && filter.value.includes(actual);
    case 'nin': return Array.isArray(filter.value) && !filter.value.includes(actual);
  }
}

export function createSqliteVectorStore(config: SqliteVectorStoreConfig): SqliteVectorStore {
  return new SqliteVectorStore(config);
}

export interface SqliteVectorStoreOptions {
  vectorFilename: string;
  platformData?: PlatformDataContext;
  readonly?: boolean;
  wal?: boolean;
}

export function createAdapter(config: SqliteVectorStoreOptions): SqliteVectorStore {
  return new SqliteVectorStore({
    filename: config.vectorFilename,
    readonly: config.readonly,
    wal: config.wal,
  });
}

export { manifest } from './manifest.js';
export default createAdapter;
