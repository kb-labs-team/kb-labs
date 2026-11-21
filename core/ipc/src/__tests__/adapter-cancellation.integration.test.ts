import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { IPlatformAdapters } from '@kb-labs/core-platform';
import { ChildIPCServer, IPCTransport, LLMProxy, createStdioChannel, StdioPlatformServer, StdioTransport } from '../index.js';

const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 1000;
  while (!predicate() && Date.now() < deadline) { await new Promise((resolve) => setTimeout(resolve, 5)); }
  if (!predicate()) { throw new Error('Condition did not become true'); }
};

describe('cancellable host adapter RPC', () => {
  // case: S-030.3
  it('aborts a pending host LLM request through the real subprocess stdio RPC chain', async () => {
    const childToHost = new PassThrough();
    const hostToChild = new PassThrough();
    const childChannel = createStdioChannel(hostToChild, childToHost);
    const hostChannel = createStdioChannel(childToHost, hostToChild);
    let providerSignal: AbortSignal | undefined;
    const platform = {
      llm: {
        complete: (_prompt: string, options?: { signal?: AbortSignal }) => {
          providerSignal = options?.signal;
          return new Promise((_resolve, reject) => {
            providerSignal?.addEventListener('abort', () => reject(providerSignal?.reason ?? new DOMException('aborted', 'AbortError')), { once: true });
          });
        },
      },
    } as unknown as IPlatformAdapters;
    const server = new StdioPlatformServer(hostChannel, platform);
    const transport = new StdioTransport(childChannel);
    const llm = new LLMProxy(transport);
    const controller = new AbortController();

    try {
      const call = llm.complete('wait for host provider', { signal: controller.signal });
      await waitFor(() => providerSignal !== undefined);
      controller.abort(new DOMException('command cancelled', 'AbortError'));

      await expect(call).rejects.toMatchObject({ name: 'AbortError' });
      expect(providerSignal?.aborted).toBe(true);
    } finally {
      await transport.close();
      await server.close();
      childChannel.close();
      hostChannel.close();
      childToHost.destroy();
      hostToChild.destroy();
    }
  });

  it('aborts a pending host LLM RPC when the stdio transport times out', async () => {
    const childToHost = new PassThrough();
    const hostToChild = new PassThrough();
    const childChannel = createStdioChannel(hostToChild, childToHost);
    const hostChannel = createStdioChannel(childToHost, hostToChild);
    let providerSignal: AbortSignal | undefined;
    const platform = {
      llm: { complete: (_prompt: string, options?: { signal?: AbortSignal }) => {
        providerSignal = options?.signal;
        return new Promise((_resolve, reject) => providerSignal?.addEventListener('abort', () => reject(providerSignal?.reason), { once: true }));
      } },
    } as unknown as IPlatformAdapters;
    const server = new StdioPlatformServer(hostChannel, platform);
    const transport = new StdioTransport(childChannel, { timeout: 30 });

    try {
      await expect(new LLMProxy(transport).complete('timeout test')).rejects.toMatchObject({ name: 'TimeoutError' });
      await waitFor(() => providerSignal?.aborted === true);
      expect(providerSignal?.aborted).toBe(true);
    } finally {
      await transport.close();
      await server.close();
      childChannel.close();
      hostChannel.close();
      childToHost.destroy();
      hostToChild.destroy();
    }
  });

  it('keeps stdio open until an active host RPC settles during forced cleanup', async () => {
    const childToHost = new PassThrough();
    const hostToChild = new PassThrough();
    const childChannel = createStdioChannel(hostToChild, childToHost);
    const hostChannel = createStdioChannel(childToHost, hostToChild);
    let providerSignal: AbortSignal | undefined;
    const platform = {
      llm: { complete: (_prompt: string, options?: { signal?: AbortSignal }) => {
        providerSignal = options?.signal;
        return new Promise((_resolve, reject) => providerSignal?.addEventListener('abort', () => reject(providerSignal?.reason ?? new DOMException('closed', 'AbortError')), { once: true }));
      } },
    } as unknown as IPlatformAdapters;
    const server = new StdioPlatformServer(hostChannel, platform);
    const transport = new StdioTransport(childChannel);

    try {
      const call = new LLMProxy(transport).complete('cleanup test');
      await waitFor(() => providerSignal !== undefined);
      await server.close();
      await expect(call).rejects.toMatchObject({ name: 'AbortError' });
      expect(providerSignal?.aborted).toBe(true);
      await expect(childChannel.send({ type: 'platform:message', payload: { type: 'still-open' } })).resolves.toBeUndefined();
    } finally {
      await transport.close();
      await server.close();
      childChannel.close();
      hostChannel.close();
      childToHost.destroy();
      hostToChild.destroy();
    }
  });

  it('aborts a pending host LLM RPC when the IPC transport times out', async () => {
    const processSendDescriptor = Object.getOwnPropertyDescriptor(process, 'send');
    const childEmitter = new EventEmitter();
    const processEmitter = process as unknown as EventEmitter;
    const child = childEmitter as unknown as ChildProcess & { connected: boolean; send: (message: unknown) => boolean };
    Object.defineProperty(child, 'connected', { configurable: true, value: true });
    child.send = (message) => { processEmitter.emit('message', message); return true; };
    Object.defineProperty(process, 'send', {
      configurable: true,
      writable: true,
      value: (message: unknown) => { queueMicrotask(() => child.emit('message', message)); return true; },
    });
    let providerSignal: AbortSignal | undefined;
    const platform = {
      llm: { complete: (_prompt: string, options?: { signal?: AbortSignal }) => {
        providerSignal = options?.signal;
        return new Promise((_resolve, reject) => providerSignal?.addEventListener('abort', () => reject(providerSignal?.reason), { once: true }));
      } },
    } as unknown as IPlatformAdapters;
    const server = new ChildIPCServer(platform, child);
    const transport = new IPCTransport({ timeout: 30 });
    server.start();

    try {
      await expect(new LLMProxy(transport).complete('IPC timeout test')).rejects.toMatchObject({ name: 'TimeoutError' });
      await waitFor(() => providerSignal?.aborted === true);
      expect(providerSignal?.aborted).toBe(true);
    } finally {
      await transport.close();
      server.stop();
      if (processSendDescriptor) { Object.defineProperty(process, 'send', processSendDescriptor); }
      else { Reflect.deleteProperty(process, 'send'); }
    }
  });
});
