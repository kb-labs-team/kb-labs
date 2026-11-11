/**
 * @module @kb-labs/core-ipc/proxy/document-database
 *
 * Child-side proxy for `IDocumentDatabase`. All RPCs go to `database.document`
 * on the parent, where the real adapter lives.
 *
 * Two operations cannot cross the IPC boundary as-is:
 *
 * - `transaction(fn)` — the callback closes over caller-side state, there is
 *    no way to ship it to the parent. Plugins that need transactional writes
 *    from a worker should accumulate the operations and issue a single
 *    `bulkWrite` (which IS atomic on the parent).
 *
 * - `findStream` — async iterators do not map cleanly to RPC. Workers should
 *    use bounded `find({ limit })` calls and paginate explicitly.
 *
 * Both are deliberate trade-offs: keeping the proxy honest about its
 * limitations beats faking semantics that quietly break.
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
} from '@kb-labs/core-platform/adapters';
import type { ITransport } from '../transport/transport';
import { RemoteAdapter } from './remote-adapter';
import type { DocumentDatabaseIPCOperation } from '../ipc/adapter-contract';

export class DocumentDatabaseProxy
  extends RemoteAdapter<IDocumentDatabase, DocumentDatabaseIPCOperation>
  implements IDocumentDatabase
{
  constructor(transport: ITransport) {
    super('database.document', transport);
  }

  async find<T extends BaseDocument, P = T>(
    collection: string,
    filter: DocumentFilter<T>,
    options?: FindOptions & ProjectOpts<T, P> & SignalOpts,
  ): Promise<P[]> {
    return (await this.callRemote('find', [collection, filter, stripSignal(options)])) as P[];
  }


  async *findStream<T extends BaseDocument, P = T>(
    _collection: string,
    _filter: DocumentFilter<T>,
    _options?: FindOptions & ProjectOpts<T, P> & SignalOpts & { batchSize?: number },
  ): AsyncIterable<P> {
    throw new Error(
      'findStream() is not supported over IPC. Use bounded find({ limit }) and paginate explicitly.',
    );
  }

  async findById<T extends BaseDocument>(
    collection: string,
    id: string,
    _options?: SignalOpts,
  ): Promise<T | null> {
    return (await this.callRemote('findById', [collection, id])) as T | null;
  }

  async count<T extends BaseDocument>(
    collection: string,
    filter: DocumentFilter<T>,
    _options?: SignalOpts,
  ): Promise<number> {
    return (await this.callRemote('count', [collection, filter])) as number;
  }

  async insertOne<T extends BaseDocument>(
    collection: string,
    doc: Omit<T, 'id' | 'createdAt' | 'updatedAt'>,
    _options?: SignalOpts,
  ): Promise<T> {
    return (await this.callRemote('insertOne', [collection, doc])) as T;
  }

  async insertMany<T extends BaseDocument>(
    collection: string,
    docs: Array<Omit<T, 'id' | 'createdAt' | 'updatedAt'>>,
    _options?: SignalOpts,
  ): Promise<T[]> {
    return (await this.callRemote('insertMany', [collection, docs])) as T[];
  }

  async updateOne<T extends BaseDocument>(
    collection: string,
    filter: DocumentFilter<T>,
    update: DocumentUpdate<T>,
    options?: SignalOpts & { upsert?: boolean },
  ): Promise<T | null> {
    return (await this.callRemote('updateOne', [
      collection,
      filter,
      update,
      { upsert: options?.upsert },
    ])) as T | null;
  }

  async updateMany<T extends BaseDocument>(
    collection: string,
    filter: DocumentFilter<T>,
    update: DocumentUpdate<T>,
    _options?: SignalOpts,
  ): Promise<number> {
    return (await this.callRemote('updateMany', [collection, filter, update])) as number;
  }

  async updateById<T extends BaseDocument>(
    collection: string,
    id: string,
    update: DocumentUpdate<T>,
    _options?: SignalOpts,
  ): Promise<T | null> {
    return (await this.callRemote('updateById', [collection, id, update])) as T | null;
  }

  async deleteMany<T extends BaseDocument>(
    collection: string,
    filter: DocumentFilter<T>,
    _options?: SignalOpts,
  ): Promise<number> {
    return (await this.callRemote('deleteMany', [collection, filter])) as number;
  }

  async deleteById(collection: string, id: string, _options?: SignalOpts): Promise<boolean> {
    return (await this.callRemote('deleteById', [collection, id])) as boolean;
  }

  async bulkWrite<T extends BaseDocument>(
    collection: string,
    ops: Array<BulkOp<T>>,
    _options?: SignalOpts,
  ): Promise<BulkResult> {
    return (await this.callRemote('bulkWrite', [collection, ops])) as BulkResult;
  }

  async transaction<T>(_fn: (tx: IDocumentTransaction) => Promise<T>): Promise<T> {
    throw new Error(
      'transaction() is not supported over IPC. Collect your writes into a single bulkWrite() instead.',
    );
  }

  async ensureCollection(name: string, options?: EnsureCollectionOpts): Promise<void> {
    await this.callRemote('ensureCollection', [name, options]);
  }

  async ping(): Promise<{ ok: boolean; latencyMs: number }> {
    return (await this.callRemote('ping', [])) as { ok: boolean; latencyMs: number };
  }

  async close(options?: { drainTimeoutMs?: number }): Promise<void> {
    await this.callRemote('close', [options]);
  }
}

const stripSignal = <T extends SignalOpts | undefined>(
  options: T,
): Omit<NonNullable<T>, 'signal'> | undefined => {
  if (!options) {return undefined;}
  const { signal: _signal, ...rest } = options;
  void _signal;
  return rest;
};

export function createDocumentDatabaseProxy(transport: ITransport): DocumentDatabaseProxy {
  return new DocumentDatabaseProxy(transport);
}
