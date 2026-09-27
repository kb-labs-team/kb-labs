/**
 * Unit tests for ChildIPCServer.
 *
 * Tests:
 * - Adapter call dispatch to real adapters
 * - Non-adapter messages are ignored (WorkerMessage coexistence)
 * - Permission enforcement (Layer 2)
 * - Lifecycle (start, stop, auto-stop on child exit)
 * - Error handling
 * - Exhaustive AdapterType dispatch
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { ChildIPCServer } from '../ipc/child-ipc-server';
import type { IPlatformAdapters } from '@kb-labs/core-platform';
import { IPC_PROTOCOL_VERSION } from '@kb-labs/core-platform/serializable';
import type { AdapterCall } from '@kb-labs/core-platform/serializable';

/**
 * Mock ChildProcess — EventEmitter with send() and connected.
 */
function createMockChild() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    send: vi.fn(),
    connected: true,
    pid: 12345,
    kill: vi.fn(),
  });
}

function createAdapterCall(
  adapter: string,
  method: string,
  args: unknown[] = [],
  context?: Record<string, unknown>,
): AdapterCall {
  return {
    version: IPC_PROTOCOL_VERSION,
    type: 'adapter:call',
    requestId: `test-${Date.now()}-${Math.random()}`,
    adapter: adapter as any,
    method,
    args: args as any,
    context: context as any,
  };
}

function createMockPlatform(): IPlatformAdapters {
  return {
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), trace: vi.fn(), child: vi.fn() } as any,
    llm: { complete: vi.fn().mockResolvedValue({ content: 'hello', usage: { promptTokens: 1, completionTokens: 1 }, model: 'test' }), stream: vi.fn() } as any,
    embeddings: { embed: vi.fn().mockResolvedValue([0.1, 0.2]), embedBatch: vi.fn(), dimensions: 1536, getDimensions: vi.fn() } as any,
    vectorStore: { search: vi.fn().mockResolvedValue([]), upsert: vi.fn(), delete: vi.fn(), count: vi.fn() } as any,
    cache: { get: vi.fn().mockResolvedValue('cached-value'), set: vi.fn(), delete: vi.fn(), clear: vi.fn(), zadd: vi.fn(), zrangebyscore: vi.fn(), zrem: vi.fn(), setIfNotExists: vi.fn() } as any,
    storage: { read: vi.fn(), write: vi.fn(), delete: vi.fn(), list: vi.fn(), exists: vi.fn() } as any,
    analytics: { track: vi.fn(), identify: vi.fn(), flush: vi.fn() } as any,
    eventBus: { publish: vi.fn(), subscribe: vi.fn() } as any,
    config: { getConfig: vi.fn(), getRawConfig: vi.fn() } as any,
    invoke: { call: vi.fn(), isAvailable: vi.fn() } as any,
    documentDatabase: { find: vi.fn(), findStream: vi.fn(), findById: vi.fn(), count: vi.fn(), insertOne: vi.fn(), insertMany: vi.fn(), updateOne: vi.fn(), updateMany: vi.fn(), updateById: vi.fn(), deleteMany: vi.fn(), deleteById: vi.fn(), bulkWrite: vi.fn(), transaction: vi.fn(), ensureCollection: vi.fn(), ping: vi.fn(), close: vi.fn() } as any,
    kvStore: { get: vi.fn(), getMany: vi.fn(), set: vi.fn(), setMany: vi.fn(), setIfNotExists: vi.fn(), delete: vi.fn(), exists: vi.fn(), cas: vi.fn(), incr: vi.fn(), ttl: vi.fn(), expire: vi.fn(), persist: vi.fn(), scan: vi.fn(), ping: vi.fn(), close: vi.fn() } as any,
    logs: { query: vi.fn(), getById: vi.fn(), search: vi.fn(), subscribe: vi.fn(), getStats: vi.fn(), getCapabilities: vi.fn() } as any,
  };
}

describe('ChildIPCServer', () => {
  let mockChild: ReturnType<typeof createMockChild>;
  let mockPlatform: IPlatformAdapters;
  let server: ChildIPCServer;

  beforeEach(() => {
    mockChild = createMockChild();
    mockPlatform = createMockPlatform();
    server = new ChildIPCServer(mockPlatform, mockChild as any);
  });

  afterEach(() => {
    server.stop();
  });

  describe('Lifecycle', () => {
    it('should start and listen for messages', () => {
      server.start();
      expect(server.isStarted()).toBe(true);
      expect(mockChild.listenerCount('message')).toBe(1);
    });

    it('should stop and remove listeners', () => {
      server.start();
      server.stop();
      expect(server.isStarted()).toBe(false);
      expect(mockChild.listenerCount('message')).toBe(0);
    });

    it('should not start twice', () => {
      server.start();
      server.start(); // idempotent
      expect(mockChild.listenerCount('message')).toBe(1);
    });

    it('should auto-stop on child exit', () => {
      server.start();
      mockChild.emit('exit', 0);
      expect(server.isStarted()).toBe(false);
    });
  });

  describe('Adapter Call Dispatch', () => {
    beforeEach(() => {
      server.start();
    });

    it('should dispatch cache.get and send response', async () => {
      const call = createAdapterCall('cache', 'get', ['my-key']);
      mockChild.emit('message', call);

      // Wait for async handling
      await vi.waitFor(() => {
        expect(mockChild.send).toHaveBeenCalled();
      });

      expect(mockPlatform.cache.get).toHaveBeenCalledWith('my-key');

      const response = mockChild.send.mock.calls[0]![0];
      expect(response.type).toBe('adapter:response');
      expect(response.requestId).toBe(call.requestId);
      expect(response.error).toBeUndefined();
    });

    it('should dispatch llm.complete and send response', async () => {
      const call = createAdapterCall('llm', 'complete', ['hello world', { temperature: 0.5 }]);
      mockChild.emit('message', call);

      await vi.waitFor(() => {
        expect(mockChild.send).toHaveBeenCalled();
      });

      expect(mockPlatform.llm.complete).toHaveBeenCalledWith('hello world', { temperature: 0.5 });
    });

    it('attaches a host AbortSignal to an in-flight LLM call and aborts it on adapter:cancel', async () => {
      let capturedSignal: AbortSignal | undefined;
      let finishCall!: (value: unknown) => void;
      (mockPlatform.llm.complete as ReturnType<typeof vi.fn>).mockImplementation(
        (_prompt: string, options: { signal?: AbortSignal }) => {
          capturedSignal = options.signal;
          return new Promise((resolve) => { finishCall = resolve; });
        },
      );
      const call = createAdapterCall('llm', 'complete', ['hello', { temperature: 0.2 }]);
      mockChild.emit('message', call);
      await vi.waitFor(() => expect(capturedSignal).toBeInstanceOf(AbortSignal));

      mockChild.emit('message', { type: 'adapter:cancel', requestId: call.requestId });
      expect(capturedSignal?.aborted).toBe(true);
      finishCall({ content: '', usage: { promptTokens: 0, completionTokens: 0 }, model: 'test' });
      await vi.waitFor(() => expect(mockChild.send).toHaveBeenCalled());
    });

    it('should dispatch vectorStore.search', async () => {
      const call = createAdapterCall('vectorStore', 'search', [[0.1, 0.2], 10]);
      mockChild.emit('message', call);

      await vi.waitFor(() => {
        expect(mockPlatform.vectorStore.search).toHaveBeenCalledWith([0.1, 0.2], 10);
      });
    });

    it('should dispatch document and KV database endpoints through their wire aliases', async () => {
      const documentCall = createAdapterCall('database.document', 'find', ['jobs', { state: 'queued' }]);
      const kvCall = createAdapterCall('database.kv', 'get', ['lease:worker-1']);

      mockChild.emit('message', documentCall);
      mockChild.emit('message', kvCall);

      await vi.waitFor(() => {
        expect(mockPlatform.documentDatabase.find).toHaveBeenCalledWith('jobs', { state: 'queued' });
        expect(mockPlatform.kvStore.get).toHaveBeenCalledWith('lease:worker-1');
      });
    });

    it('should handle adapter method errors', async () => {
      (mockPlatform.cache.get as any).mockRejectedValue(new Error('Redis down'));

      const call = createAdapterCall('cache', 'get', ['broken-key']);
      mockChild.emit('message', call);

      await vi.waitFor(() => {
        expect(mockChild.send).toHaveBeenCalled();
      });

      const response = mockChild.send.mock.calls[0]![0];
      expect(response.type).toBe('adapter:response');
      expect(response.error).toBeDefined();
    });

    it('should handle unknown method on adapter', async () => {
      const call = createAdapterCall('cache', 'nonExistentMethod', []);
      mockChild.emit('message', call);

      await vi.waitFor(() => {
        expect(mockChild.send).toHaveBeenCalled();
      });

      const response = mockChild.send.mock.calls[0]![0];
      expect(response.error).toBeDefined();
    });
  });

  describe('Message Filtering', () => {
    beforeEach(() => {
      server.start();
    });

    it('should ignore WorkerMessage types (execute, result, etc.)', async () => {
      // These are WorkerMessages — ChildIPCServer should ignore them
      mockChild.emit('message', { type: 'execute', requestId: '1', request: {}, timeoutMs: 5000 });
      mockChild.emit('message', { type: 'result', requestId: '1', result: {} });
      mockChild.emit('message', { type: 'ready', pid: 123 });
      mockChild.emit('message', { type: 'healthOk', memoryUsage: {} });

      // None should trigger adapter dispatch
      await new Promise<void>(resolve => { setTimeout(resolve, 50); });
      expect(mockChild.send).not.toHaveBeenCalled();
    });

    it('should ignore plain strings and numbers', async () => {
      mockChild.emit('message', 'hello');
      mockChild.emit('message', 42);
      mockChild.emit('message', null);

      await new Promise<void>(resolve => { setTimeout(resolve, 50); });
      expect(mockChild.send).not.toHaveBeenCalled();
    });
  });

  describe('Permission Enforcement (Layer 2)', () => {
    beforeEach(() => {
      server.start();
    });

    it('should allow adapter call when no permissions context', async () => {
      // No context.permissions = allow (backward compat)
      const call = createAdapterCall('llm', 'complete', ['test']);
      mockChild.emit('message', call);

      await vi.waitFor(() => {
        expect(mockPlatform.llm.complete).toHaveBeenCalled();
      });
    });

    it('should allow adapter call when adapter is in allowed list', async () => {
      const call = createAdapterCall('llm', 'complete', ['test'], {
        permissions: { adapters: ['llm', 'cache'] },
      });
      mockChild.emit('message', call);

      await vi.waitFor(() => {
        expect(mockPlatform.llm.complete).toHaveBeenCalled();
      });
    });

    it('should deny adapter call when adapter not in allowed list', async () => {
      const call = createAdapterCall('llm', 'complete', ['test'], {
        permissions: { adapters: ['cache'] }, // llm NOT listed
      });
      mockChild.emit('message', call);

      await vi.waitFor(() => {
        expect(mockChild.send).toHaveBeenCalled();
      });

      expect(mockPlatform.llm.complete).not.toHaveBeenCalled();
      const response = mockChild.send.mock.calls[0]![0];
      expect(response.error).toBeDefined();
    });

    it('should allow when permissions.adapters is absent (no restrictions)', async () => {
      const call = createAdapterCall('llm', 'complete', ['test'], {
        permissions: {}, // No adapters field = no restrictions
      });
      mockChild.emit('message', call);

      await vi.waitFor(() => {
        expect(mockPlatform.llm.complete).toHaveBeenCalled();
      });
    });
  });

  describe('Connection State', () => {
    it('should not send response if child disconnected', async () => {
      server.start();
      mockChild.connected = false;

      const call = createAdapterCall('cache', 'get', ['key']);
      mockChild.emit('message', call);

      await vi.waitFor(() => {
        expect(mockPlatform.cache.get).toHaveBeenCalled();
      });

      // send() should not be called because child is disconnected
      expect(mockChild.send).not.toHaveBeenCalled();
    });
  });

  describe('EventBus IPC', () => {
    beforeEach(() => {
      // subscribe must return a function so stop() can call it
      (mockPlatform.eventBus.subscribe as ReturnType<typeof vi.fn>).mockReturnValue(() => {});
      server.start();
    });

    it('eventbus:subscribe — subscribes to platform.eventBus with given topic', async () => {
      mockChild.emit('message', { type: 'eventbus:subscribe', subscriptionId: 'sub-1', topic: 'workflow.done' });
      await vi.waitFor(() => {
        expect(mockPlatform.eventBus.subscribe).toHaveBeenCalledWith('workflow.done', expect.any(Function));
      });
      expect(mockChild.send).toHaveBeenCalledWith({ type: 'eventbus:subscribed', subscriptionId: 'sub-1' });
    });

    it('eventbus:subscribe — sends eventbus:push to child when event fires', async () => {
      let capturedHandler: ((payload: unknown) => Promise<void>) | null = null;
      (mockPlatform.eventBus.subscribe as ReturnType<typeof vi.fn>).mockImplementation(
        (_topic: string, handler: (payload: unknown) => Promise<void>) => {
          capturedHandler = handler;
          return () => {};
        }
      );

      mockChild.emit('message', { type: 'eventbus:subscribe', subscriptionId: 'sub-2', topic: 'events.x' });
      await vi.waitFor(() => capturedHandler !== null);

      await capturedHandler!({ value: 42 });

      expect(mockChild.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'eventbus:push',
        subscriptionId: 'sub-2',
        topic: 'events.x',
      }));
    });

    it('eventbus:subscribe — does not push when child disconnected', async () => {
      let capturedHandler: ((payload: unknown) => Promise<void>) | null = null;
      (mockPlatform.eventBus.subscribe as ReturnType<typeof vi.fn>).mockImplementation(
        (_topic: string, handler: (payload: unknown) => Promise<void>) => {
          capturedHandler = handler;
          return () => {};
        }
      );

      mockChild.emit('message', { type: 'eventbus:subscribe', subscriptionId: 'sub-3', topic: 'events.y' });
      await vi.waitFor(() => capturedHandler !== null);

      // The subscribe acknowledgement is expected; only event pushes should be suppressed.
      mockChild.send.mockClear();
      mockChild.connected = false;
      await capturedHandler!({ value: 1 });
      expect(mockChild.send).not.toHaveBeenCalled();
    });

    it('eventbus:unsubscribe — calls stored unsubscribe function', async () => {
      const unsub = vi.fn();
      (mockPlatform.eventBus.subscribe as ReturnType<typeof vi.fn>).mockReturnValue(unsub);

      mockChild.emit('message', { type: 'eventbus:subscribe', subscriptionId: 'sub-4', topic: 'events.z' });
      await vi.waitFor(() => {
        expect(mockPlatform.eventBus.subscribe).toHaveBeenCalled();
      });

      mockChild.emit('message', { type: 'eventbus:unsubscribe', subscriptionId: 'sub-4' });
      await vi.waitFor(() => expect(unsub).toHaveBeenCalled());
    });

    it('eventbus:unsubscribe — ignores unknown subscriptionId gracefully', () => {
      expect(() => {
        mockChild.emit('message', { type: 'eventbus:unsubscribe', subscriptionId: 'nonexistent' });
      }).not.toThrow();
    });

    it('stop() — cancels all active EventBus subscriptions', async () => {
      const unsub1 = vi.fn();
      const unsub2 = vi.fn();
      (mockPlatform.eventBus.subscribe as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(unsub1)
        .mockReturnValueOnce(unsub2);

      mockChild.emit('message', { type: 'eventbus:subscribe', subscriptionId: 'sub-5', topic: 'a' });
      mockChild.emit('message', { type: 'eventbus:subscribe', subscriptionId: 'sub-6', topic: 'b' });
      await vi.waitFor(() => {
        expect(mockPlatform.eventBus.subscribe).toHaveBeenCalledTimes(2);
      });

      server.stop();
      expect(unsub1).toHaveBeenCalled();
      expect(unsub2).toHaveBeenCalled();
    });

    it('ignores eventbus:subscribe when platform.eventBus is absent', () => {
      const platformWithoutBus = { ...mockPlatform, eventBus: undefined as never };
      const srv = new ChildIPCServer(platformWithoutBus, mockChild as never);
      srv.start();
      expect(() => {
        mockChild.emit('message', { type: 'eventbus:subscribe', subscriptionId: 's', topic: 't' });
      }).not.toThrow();
      expect(mockChild.send).toHaveBeenCalledWith({ type: 'eventbus:subscribed', subscriptionId: 's' });
      srv.stop();
    });
  });
});
