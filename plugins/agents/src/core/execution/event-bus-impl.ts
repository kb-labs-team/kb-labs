/**
 * EventBusImpl — simple in-process implementation of AgentEventBus.
 *
 * Design:
 *   - Synchronous emit: handlers run inline, no async queuing
 *   - Error isolation: one handler throwing does not affect others
 *   - No recursion guard needed (sync + in-process only)
 *   - drain() is a no-op since emit is synchronous
 */

import type { AgentEventBus, AgentEvents, Unsubscribe } from '../../sdk/index.js';

type Handler<T> = (data: T) => void;

export class EventBusImpl implements AgentEventBus {
  private readonly _handlers = new Map<string, Set<Handler<unknown>>>();

  emit<K extends keyof AgentEvents>(event: K, data: AgentEvents[K]): void {
    const handlers = this._handlers.get(event as string);
    if (!handlers) {return;}
    for (const handler of handlers) {
      try {
        handler(data);
      } catch {
        // Error isolation: handler failure does not propagate
      }
    }
  }

  on<K extends keyof AgentEvents>(
    event: K,
    handler: (data: AgentEvents[K]) => void,
  ): Unsubscribe {
    let set = this._handlers.get(event as string);
    if (!set) {
      set = new Set();
      this._handlers.set(event as string, set);
    }
    set.add(handler as Handler<unknown>);
    return () => {
      this._handlers.get(event as string)?.delete(handler as Handler<unknown>);
    };
  }

  onAsync<K extends keyof AgentEvents>(
    event: K,
    handler: (data: AgentEvents[K]) => Promise<void>,
  ): Unsubscribe {
    // Wrap async handler — fire-and-forget, errors swallowed
    return this.on(event, (data) => {
      handler(data).catch(() => {});
    });
  }

  async drain(): Promise<void> {
    // No-op: emit is synchronous, nothing pending
  }

  clear(): void {
    this._handlers.clear();
  }
}

export function createEventBus(): AgentEventBus {
  return new EventBusImpl();
}
