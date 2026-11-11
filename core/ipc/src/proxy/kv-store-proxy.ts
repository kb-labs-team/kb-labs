/**
 * @module @kb-labs/core-ipc/proxy/kv-store
 *
 * Child-side proxy for `IKVStore`. All RPCs go to `database.kv` on the parent.
 *
 * `scan()` is intentionally not supported across the IPC boundary — async
 * iterators don't round-trip cleanly. Workers that need to enumerate keys
 * should call `getMany` with an explicit key list, or do bounded reads.
 */

import type {
  IKVStore,
  SetOpts,
  SignalOpts,
} from '@kb-labs/core-platform/adapters';
import type { ITransport } from '../transport/transport';
import { RemoteAdapter } from './remote-adapter';
import type { KVStoreIPCOperation } from '../ipc/adapter-contract';

export class KVStoreProxy extends RemoteAdapter<IKVStore, KVStoreIPCOperation> implements IKVStore {
  constructor(transport: ITransport) {
    super('database.kv', transport);
  }

  async get<T = unknown>(key: string, _options?: SignalOpts): Promise<T | null> {
    return (await this.callRemote('get', [key])) as T | null;
  }

  async getMany<T = unknown>(keys: string[], _options?: SignalOpts): Promise<Array<T | null>> {
    return (await this.callRemote('getMany', [keys])) as Array<T | null>;
  }

  async set<T = unknown>(key: string, value: T, options?: SetOpts): Promise<boolean> {
    return (await this.callRemote('set', [key, value, stripSignal(options)])) as boolean;
  }

  async setMany<T = unknown>(
    entries: Array<{ key: string; value: T; ttlMs?: number }>,
    _options?: SignalOpts,
  ): Promise<void> {
    await this.callRemote('setMany', [entries]);
  }

  async setIfNotExists<T = unknown>(
    key: string,
    value: T,
    options?: { ttlMs?: number } & SignalOpts,
  ): Promise<boolean> {
    return (await this.callRemote('setIfNotExists', [key, value, stripSignal(options)])) as boolean;
  }

  async delete(key: string, _options?: SignalOpts): Promise<boolean> {
    return (await this.callRemote('delete', [key])) as boolean;
  }

  async exists(key: string, _options?: SignalOpts): Promise<boolean> {
    return (await this.callRemote('exists', [key])) as boolean;
  }

  async cas<T = unknown>(
    key: string,
    expected: T,
    next: T,
    options?: { ttlMs?: number } & SignalOpts,
  ): Promise<boolean> {
    return (await this.callRemote('cas', [key, expected, next, stripSignal(options)])) as boolean;
  }

  async incr(key: string, delta?: number, options?: { ttlMs?: number } & SignalOpts): Promise<number> {
    return (await this.callRemote('incr', [key, delta, stripSignal(options)])) as number;
  }

  async ttl(key: string): Promise<number | null> {
    return (await this.callRemote('ttl', [key])) as number | null;
  }

  async expire(key: string, ttlMs: number): Promise<boolean> {
    return (await this.callRemote('expire', [key, ttlMs])) as boolean;
  }

  async persist(key: string): Promise<boolean> {
    return (await this.callRemote('persist', [key])) as boolean;
  }


  async *scan(
    _prefix?: string,
    _options?: { batchSize?: number } & SignalOpts,
  ): AsyncIterable<{ key: string; value: unknown }> {
    throw new Error('scan() is not supported over IPC. Use bounded getMany() with an explicit key list.');
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

export function createKVStoreProxy(transport: ITransport): KVStoreProxy {
  return new KVStoreProxy(transport);
}
