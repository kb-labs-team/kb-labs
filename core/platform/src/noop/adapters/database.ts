/**
 * @module @kb-labs/core-platform/noop/adapters/database
 *
 * Default implementations used when no concrete adapter is configured.
 *
 * Both throw on real I/O operations — the platform still constructs them so
 * that `platform.documentDatabase` / `platform.kvStore` always have a value
 * and the type checker is happy. The error makes the misconfiguration
 * obvious as soon as a plugin tries to use the adapter, rather than failing
 * silently.
 *
 * `ping()` and `close()` are the exceptions: both succeed so that
 * health-check loops and graceful shutdown work uniformly whether or not the
 * adapter is configured.
 */

import type {
  IDocumentDatabase,
  IDocumentTransaction,
  BaseDocument,
  DocumentFilter,
  DocumentUpdate,
  FindOptions,
  ProjectOpts,
  SignalOpts,
  EnsureCollectionOpts,
  BulkOp,
  BulkResult,
  IKVStore,
  SetOpts,
} from '../../adapters/database.js';

const NOT_CONFIGURED_DOC = 'Document database is not configured. Set `adapters.documentDatabase` in kb.config.json.';
const NOT_CONFIGURED_KV = 'KV store is not configured. Set `adapters.kvStore` in kb.config.json.';

/**
 * NoOp document database — every operation throws.
 *
 * Plugins that don't declare `permissions.platform.database.document` should
 * never receive a real instance, so this NoOp serves both as the default and
 * as a guard against unintentional storage use.
 */
export class NoOpDocumentDatabase implements IDocumentDatabase {
  async find<T extends BaseDocument, P = T>(
    _collection: string,
    _filter: DocumentFilter<T>,
    _options?: FindOptions & ProjectOpts<T, P> & SignalOpts,
  ): Promise<P[]> {
    throw new Error(NOT_CONFIGURED_DOC);
  }


  async *findStream<T extends BaseDocument, P = T>(
    _collection: string,
    _filter: DocumentFilter<T>,
    _options?: FindOptions & ProjectOpts<T, P> & SignalOpts & { batchSize?: number },
  ): AsyncIterable<P> {
    throw new Error(NOT_CONFIGURED_DOC);
  }

  async findById<T extends BaseDocument>(
    _collection: string,
    _id: string,
    _options?: SignalOpts,
  ): Promise<T | null> {
    throw new Error(NOT_CONFIGURED_DOC);
  }

  async count<T extends BaseDocument>(
    _collection: string,
    _filter: DocumentFilter<T>,
    _options?: SignalOpts,
  ): Promise<number> {
    throw new Error(NOT_CONFIGURED_DOC);
  }

  async insertOne<T extends BaseDocument>(
    _collection: string,
    _doc: Omit<T, 'id' | 'createdAt' | 'updatedAt'>,
    _options?: SignalOpts,
  ): Promise<T> {
    throw new Error(NOT_CONFIGURED_DOC);
  }

  async insertMany<T extends BaseDocument>(
    _collection: string,
    _docs: Array<Omit<T, 'id' | 'createdAt' | 'updatedAt'>>,
    _options?: SignalOpts,
  ): Promise<T[]> {
    throw new Error(NOT_CONFIGURED_DOC);
  }

  async updateOne<T extends BaseDocument>(
    _collection: string,
    _filter: DocumentFilter<T>,
    _update: DocumentUpdate<T>,
    _options?: SignalOpts & { upsert?: boolean },
  ): Promise<T | null> {
    throw new Error(NOT_CONFIGURED_DOC);
  }

  async updateMany<T extends BaseDocument>(
    _collection: string,
    _filter: DocumentFilter<T>,
    _update: DocumentUpdate<T>,
    _options?: SignalOpts,
  ): Promise<number> {
    throw new Error(NOT_CONFIGURED_DOC);
  }

  async updateById<T extends BaseDocument>(
    _collection: string,
    _id: string,
    _update: DocumentUpdate<T>,
    _options?: SignalOpts,
  ): Promise<T | null> {
    throw new Error(NOT_CONFIGURED_DOC);
  }

  async deleteMany<T extends BaseDocument>(
    _collection: string,
    _filter: DocumentFilter<T>,
    _options?: SignalOpts,
  ): Promise<number> {
    throw new Error(NOT_CONFIGURED_DOC);
  }

  async deleteById(
    _collection: string,
    _id: string,
    _options?: SignalOpts,
  ): Promise<boolean> {
    throw new Error(NOT_CONFIGURED_DOC);
  }

  async bulkWrite<T extends BaseDocument>(
    _collection: string,
    _ops: Array<BulkOp<T>>,
    _options?: SignalOpts,
  ): Promise<BulkResult> {
    throw new Error(NOT_CONFIGURED_DOC);
  }

  async transaction<T>(_fn: (tx: IDocumentTransaction) => Promise<T>): Promise<T> {
    throw new Error(NOT_CONFIGURED_DOC);
  }

  async ensureCollection(_name: string, _options?: EnsureCollectionOpts): Promise<void> {
    throw new Error(NOT_CONFIGURED_DOC);
  }

  async ping(): Promise<{ ok: boolean; latencyMs: number }> {
    return { ok: true, latencyMs: 0 };
  }

  async close(_options?: { drainTimeoutMs?: number }): Promise<void> {
    /* nothing to close */
  }
}

/**
 * NoOp KV store — every read/write throws.
 *
 * Mirrors `NoOpDocumentDatabase` in spirit: the platform always has an
 * instance; misconfiguration surfaces as an obvious error on first real use.
 */
export class NoOpKVStore implements IKVStore {
  async get<T = unknown>(_key: string, _options?: SignalOpts): Promise<T | null> {
    throw new Error(NOT_CONFIGURED_KV);
  }

  async getMany<T = unknown>(_keys: string[], _options?: SignalOpts): Promise<Array<T | null>> {
    throw new Error(NOT_CONFIGURED_KV);
  }

  async set<T = unknown>(_key: string, _value: T, _options?: SetOpts): Promise<boolean> {
    throw new Error(NOT_CONFIGURED_KV);
  }

  async setMany<T = unknown>(
    _entries: Array<{ key: string; value: T; ttlMs?: number }>,
    _options?: SignalOpts,
  ): Promise<void> {
    throw new Error(NOT_CONFIGURED_KV);
  }

  async setIfNotExists<T = unknown>(
    _key: string,
    _value: T,
    _options?: { ttlMs?: number } & SignalOpts,
  ): Promise<boolean> {
    throw new Error(NOT_CONFIGURED_KV);
  }

  async delete(_key: string, _options?: SignalOpts): Promise<boolean> {
    throw new Error(NOT_CONFIGURED_KV);
  }

  async exists(_key: string, _options?: SignalOpts): Promise<boolean> {
    throw new Error(NOT_CONFIGURED_KV);
  }

  async cas<T = unknown>(
    _key: string,
    _expected: T,
    _next: T,
    _options?: { ttlMs?: number } & SignalOpts,
  ): Promise<boolean> {
    throw new Error(NOT_CONFIGURED_KV);
  }

  async incr(
    _key: string,
    _delta?: number,
    _options?: { ttlMs?: number } & SignalOpts,
  ): Promise<number> {
    throw new Error(NOT_CONFIGURED_KV);
  }

  async ttl(_key: string): Promise<number | null> {
    throw new Error(NOT_CONFIGURED_KV);
  }

  async expire(_key: string, _ttlMs: number): Promise<boolean> {
    throw new Error(NOT_CONFIGURED_KV);
  }

  async persist(_key: string): Promise<boolean> {
    throw new Error(NOT_CONFIGURED_KV);
  }


  async *scan(
    _prefix?: string,
    _options?: { batchSize?: number } & SignalOpts,
  ): AsyncIterable<{ key: string; value: unknown }> {
    throw new Error(NOT_CONFIGURED_KV);
  }

  async ping(): Promise<{ ok: boolean; latencyMs: number }> {
    return { ok: true, latencyMs: 0 };
  }

  async close(_options?: { drainTimeoutMs?: number }): Promise<void> {
    /* nothing to close */
  }
}
