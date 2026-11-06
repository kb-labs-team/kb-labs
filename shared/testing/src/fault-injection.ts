import type { ICache, IEventBus } from '@kb-labs/core-platform';

export type CacheOperation =
  | { name: 'get'; key: string }
  | { name: 'set'; key: string; value: unknown; ttl?: number }
  | { name: 'delete'; key: string }
  | { name: 'clear'; pattern?: string }
  | { name: 'zadd'; key: string; score: number; member: string }
  | { name: 'zrangebyscore'; key: string; min: number; max: number }
  | { name: 'zrem'; key: string; member: string }
  | { name: 'setIfNotExists'; key: string; value: unknown; ttl?: number };

export type EventBusOperation = { name: 'publish'; topic: string; event: unknown };

/** ICache adapter decorator for deterministic adapter-failure tests. */
export class FaultInjectingCache implements ICache {
  constructor(
    private readonly delegate: ICache,
    private readonly failureFor: (operation: CacheOperation) => Error | undefined | Promise<Error | undefined>,
  ) {}

  private async fail(operation: CacheOperation): Promise<void> {
    const error = await this.failureFor(operation);
    if (error) {throw error;}
  }

  async get<T>(key: string): Promise<T | null> {
    await this.fail({ name: 'get', key });
    return this.delegate.get<T>(key);
  }

  async set<T>(key: string, value: T, ttl?: number): Promise<void> {
    await this.fail({ name: 'set', key, value, ttl });
    return this.delegate.set(key, value, ttl);
  }

  async delete(key: string): Promise<void> {
    await this.fail({ name: 'delete', key });
    return this.delegate.delete(key);
  }

  async clear(pattern?: string): Promise<void> {
    await this.fail({ name: 'clear', pattern });
    return this.delegate.clear(pattern);
  }

  async zadd(key: string, score: number, member: string): Promise<void> {
    await this.fail({ name: 'zadd', key, score, member });
    return this.delegate.zadd(key, score, member);
  }

  async zrangebyscore(key: string, min: number, max: number): Promise<string[]> {
    await this.fail({ name: 'zrangebyscore', key, min, max });
    return this.delegate.zrangebyscore(key, min, max);
  }

  async zrem(key: string, member: string): Promise<void> {
    await this.fail({ name: 'zrem', key, member });
    return this.delegate.zrem(key, member);
  }

  async setIfNotExists<T>(key: string, value: T, ttl?: number): Promise<boolean> {
    await this.fail({ name: 'setIfNotExists', key, value, ttl });
    return this.delegate.setIfNotExists(key, value, ttl);
  }
}

/** IEventBus adapter decorator for deterministic adapter-failure tests. */
export class FaultInjectingEventBus implements IEventBus {
  constructor(
    private readonly delegate: IEventBus,
    private readonly failureFor: (operation: EventBusOperation) => Error | undefined | Promise<Error | undefined>,
  ) {}

  async publish<T>(topic: string, event: T): Promise<void> {
    const error = await this.failureFor({ name: 'publish', topic, event });
    if (error) {throw error;}
    return this.delegate.publish(topic, event);
  }

  subscribe<T>(topic: string, handler: (event: T) => Promise<void>): () => void {
    return this.delegate.subscribe(topic, handler);
  }
}
