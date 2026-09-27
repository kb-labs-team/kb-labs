/**
 * @module @kb-labs/core-ipc/proxy/event-bus-proxy
 *
 * Bidirectional EventBus proxy for child processes.
 *
 * publish  → adapter:call RPC (existing pattern)
 * subscribe → eventbus:subscribe (fire-and-forget) + eventbus:push (push from parent)
 * unsubscribe → eventbus:unsubscribe (fire-and-forget)
 */

import { randomUUID } from 'node:crypto';
import type { IEventBus, EventHandler, Unsubscribe } from '@kb-labs/core-platform/adapters';
import type { ITransport } from '../transport/transport.js';
import { isEventBusPush, isEventBusSubscribed, serialize, deserialize } from '@kb-labs/core-platform/serializable';
import { IPC_PROTOCOL_VERSION } from '@kb-labs/core-platform/serializable';

export class EventBusProxy implements IEventBus {
  private handlers = new Map<string, { topic: string; handler: EventHandler<unknown> }>();
  private subscriptionWaiters = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private unregisterPush: () => void;

  constructor(private readonly transport: ITransport) {
    this.unregisterPush = transport.onPushMessage(this.handlePush.bind(this));
  }

  async publish<T>(topic: string, event: T): Promise<void> {
    const response = await this.transport.send({
      version: IPC_PROTOCOL_VERSION,
      type: 'adapter:call',
      requestId: randomUUID(),
      adapter: 'eventBus',
      method: 'publish',
      args: [serialize(topic) as never, serialize(event) as never],
    });

    if (response.error) {
      const err = deserialize(response.error);
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  subscribe<T>(topic: string, handler: EventHandler<T>): Unsubscribe {
    const subscriptionId = randomUUID();

    this.handlers.set(subscriptionId, { topic, handler: handler as EventHandler<unknown> });

    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // Existing consumers may ignore readiness; mark rejections handled while
    // preserving rejection for callers that explicitly await `unsubscribe.ready`.
    void ready.catch(() => undefined);
    const timer = setTimeout(() => {
      this.subscriptionWaiters.delete(subscriptionId);
      rejectReady(new Error(`EventBus subscription acknowledgement timed out for ${topic}`));
    }, 10_000);
    timer.unref?.();
    this.subscriptionWaiters.set(subscriptionId, { resolve: resolveReady, reject: rejectReady, timer });

    this.transport.sendMessage({
      type: 'eventbus:subscribe',
      subscriptionId,
      topic,
    });

    const unsubscribe = (() => {
      if (!this.handlers.has(subscriptionId)) { return; }
      this.handlers.delete(subscriptionId);
      const waiter = this.subscriptionWaiters.get(subscriptionId);
      if (waiter) {
        clearTimeout(waiter.timer);
        this.subscriptionWaiters.delete(subscriptionId);
        waiter.resolve();
      }
      this.transport.sendMessage({
        type: 'eventbus:unsubscribe',
        subscriptionId,
      });
    }) as Unsubscribe;
    unsubscribe.ready = ready;
    return unsubscribe;
  }

  dispose(): void {
    this.unregisterPush();
    this.handlers.clear();
  }

  private handlePush(msg: unknown): void {
    if (isEventBusSubscribed(msg)) {
      const waiter = this.subscriptionWaiters.get(msg.subscriptionId);
      if (waiter) {
        clearTimeout(waiter.timer);
        this.subscriptionWaiters.delete(msg.subscriptionId);
        waiter.resolve();
      }
      return;
    }
    if (!isEventBusPush(msg)) { return; }
    const entry = this.handlers.get(msg.subscriptionId);
    if (!entry) { return; }
    const payload = deserialize(msg.payload);
    entry.handler(payload).catch(() => {});
  }
}
