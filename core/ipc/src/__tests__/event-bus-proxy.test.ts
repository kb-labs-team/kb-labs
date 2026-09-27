import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventBusProxy } from '../proxy/event-bus-proxy';
import type { ITransport } from '../transport/transport';
import type { AdapterCall, AdapterResponse } from '@kb-labs/core-platform/serializable';
import { IPC_PROTOCOL_VERSION } from '@kb-labs/core-platform/serializable';
import { serialize } from '@kb-labs/core-platform/serializable';

function createMockTransport() {
  const pushListeners = new Set<(msg: unknown) => void>();
  const sentMessages: unknown[] = [];

  const transport: ITransport = {
    send: vi.fn(async (call: AdapterCall): Promise<AdapterResponse> => ({
      type: 'adapter:response',
      requestId: call.requestId,
      result: null,
    })),
    sendMessage: vi.fn((msg: unknown) => { sentMessages.push(msg); }),
    onPushMessage: vi.fn((fn: (msg: unknown) => void) => {
      pushListeners.add(fn);
      return () => { pushListeners.delete(fn); };
    }),
    close: vi.fn(async () => {}),
    isClosed: vi.fn(() => false),
  };

  const push = (msg: unknown) => { for (const fn of pushListeners) { fn(msg); } };

  return { transport, sentMessages, push };
}

describe('EventBusProxy', () => {
  let transport: ITransport;
  let sentMessages: unknown[];
  let push: (msg: unknown) => void;

  beforeEach(() => {
    ({ transport, sentMessages, push } = createMockTransport());
  });

  it('registers onPushMessage listener on construction', () => {
    new EventBusProxy(transport);
    expect(transport.onPushMessage).toHaveBeenCalledOnce();
  });

  it('subscribe sends eventbus:subscribe to parent', () => {
    const proxy = new EventBusProxy(transport);
    proxy.subscribe('my-topic', vi.fn());

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toMatchObject({
      type: 'eventbus:subscribe',
      topic: 'my-topic',
    });
  });

  it('resolves readiness only after the parent confirms the subscription', async () => {
    const proxy = new EventBusProxy(transport);
    const unsubscribe = proxy.subscribe('my-topic', vi.fn());
    let ready = false;
    void unsubscribe.ready?.then(() => { ready = true; });
    await Promise.resolve();
    expect(ready).toBe(false);

    const subscriptionId = (sentMessages[0] as { subscriptionId: string }).subscriptionId;
    push({ type: 'eventbus:subscribed', subscriptionId });
    await unsubscribe.ready;
    expect(ready).toBe(true);
    unsubscribe();
  });

  it('unsubscribe sends eventbus:unsubscribe and removes local handler', () => {
    const proxy = new EventBusProxy(transport);
    const handler = vi.fn();
    const unsub = proxy.subscribe('my-topic', handler);
    const subscriptionId = (sentMessages[0] as { subscriptionId: string }).subscriptionId;

    unsub();

    expect(sentMessages).toHaveLength(2);
    expect(sentMessages[1]).toMatchObject({
      type: 'eventbus:unsubscribe',
      subscriptionId,
    });

    // After unsubscribe, push should not call handler
    push({ type: 'eventbus:push', subscriptionId, topic: 'my-topic', payload: serialize('event') });
    expect(handler).not.toHaveBeenCalled();
  });

  it('dispatches eventbus:push to the correct handler', async () => {
    const proxy = new EventBusProxy(transport);
    const handler = vi.fn(async () => {});
    proxy.subscribe('my-topic', handler);

    const subscriptionId = (sentMessages[0] as { subscriptionId: string }).subscriptionId;
    push({ type: 'eventbus:push', subscriptionId, topic: 'my-topic', payload: serialize({ data: 42 }) });

    // Allow async handler to settle
    await new Promise<void>(resolve => { setTimeout(resolve, 0); });
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ data: 42 }));
  });

  it('does not dispatch push to other subscriptions', async () => {
    const proxy = new EventBusProxy(transport);
    const handlerA = vi.fn(async () => {});
    const handlerB = vi.fn(async () => {});
    proxy.subscribe('topic-a', handlerA);
    proxy.subscribe('topic-b', handlerB);

    const subA = (sentMessages[0] as { subscriptionId: string }).subscriptionId;
    push({ type: 'eventbus:push', subscriptionId: subA, topic: 'topic-a', payload: serialize('ev') });

    await new Promise<void>(resolve => { setTimeout(resolve, 0); });
    expect(handlerA).toHaveBeenCalledOnce();
    expect(handlerB).not.toHaveBeenCalled();
  });

  it('publish forwards via transport.send as adapter:call', async () => {
    const proxy = new EventBusProxy(transport);
    await proxy.publish('my-topic', { value: 1 });

    expect(transport.send).toHaveBeenCalledWith(expect.objectContaining({
      version: IPC_PROTOCOL_VERSION,
      type: 'adapter:call',
      adapter: 'eventBus',
      method: 'publish',
    }));
  });

  it('ignores non-eventbus:push messages', async () => {
    const proxy = new EventBusProxy(transport);
    const handler = vi.fn(async () => {});
    proxy.subscribe('topic', handler);

    push({ type: 'adapter:response', requestId: 'x', result: null });
    push({ type: 'something-else', data: 'blah' });

    await new Promise<void>(resolve => { setTimeout(resolve, 0); });
    expect(handler).not.toHaveBeenCalled();
  });
});
