import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { IPlatformAdapters } from '@kb-labs/core-platform';
import { ChildIPCServer, IPCTransport, LLMProxy, createStdioChannel, StdioPlatformServer, StdioTransport } from '../index.js';

const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 1000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise<void>((resolve) => { setTimeout(resolve, 5); });
  }
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
        return new Promise((_resolve, reject) => { providerSignal?.addEventListener('abort', () => reject(providerSignal?.reason), { once: true }); });
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
        return new Promise((_resolve, reject) => { providerSignal?.addEventListener('abort', () => reject(providerSignal?.reason ?? new DOMException('closed', 'AbortError')), { once: true }); });
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

  it('handles stdio cancellation when the control pipe has already closed', async () => {
    const childToHost = new PassThrough();
    const hostToChild = new PassThrough();
    const childChannel = createStdioChannel(hostToChild, childToHost);
    const hostChannel = createStdioChannel(childToHost, hostToChild);
    let providerSignal: AbortSignal | undefined;
    const platform = {
      llm: { complete: (_prompt: string, options?: { signal?: AbortSignal }) => {
        providerSignal = options?.signal;
        return new Promise((_resolve, reject) => {
          providerSignal?.addEventListener('abort', () => reject(providerSignal?.reason), { once: true });
        });
      } },
    } as unknown as IPlatformAdapters;
    const server = new StdioPlatformServer(hostChannel, platform);
    const transport = new StdioTransport(childChannel);
    const controller = new AbortController();

    try {
      const call = new LLMProxy(transport).complete('closed pipe', { signal: controller.signal });
      await waitFor(() => providerSignal !== undefined);
      childToHost.destroy();
      controller.abort(new DOMException('caller cancelled', 'AbortError'));
      await expect(call).rejects.toMatchObject({ name: 'AbortError' });
      await server.close();
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
      value: (message: unknown, _handle: unknown, _options: unknown, callback?: (error: Error | null) => void) => {
        queueMicrotask(() => { child.emit('message', message); callback?.(null); });
        return true;
      },
    });
    let providerSignal: AbortSignal | undefined;
    const platform = {
      llm: { complete: (_prompt: string, options?: { signal?: AbortSignal }) => {
        providerSignal = options?.signal;
        return new Promise((_resolve, reject) => {
          providerSignal?.addEventListener('abort', () => reject(providerSignal?.reason), { once: true });
        });
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

  it('does not resend an IPC RPC when process.send reports queued backpressure', async () => {
    const processSendDescriptor = Object.getOwnPropertyDescriptor(process, 'send');
    const childEmitter = new EventEmitter();
    const processEmitter = process as unknown as EventEmitter;
    const child = childEmitter as unknown as ChildProcess & { connected: boolean; send: (message: unknown) => boolean };
    Object.defineProperty(child, 'connected', { configurable: true, value: true });
    child.send = (message) => { processEmitter.emit('message', message); return true; };
    Object.defineProperty(process, 'send', {
      configurable: true,
      writable: true,
      value: (message: unknown, _handle: unknown, _options: unknown, callback?: (error: Error | null) => void) => {
        queueMicrotask(() => { child.emit('message', message); callback?.(null); });
        return false;
      },
    });
    let providerSignal: AbortSignal | undefined;
    let providerCalls = 0;
    const platform = {
      llm: { complete: (_prompt: string, options?: { signal?: AbortSignal }) => {
        providerCalls += 1;
        providerSignal = options?.signal;
        return new Promise((_resolve, reject) => {
          providerSignal?.addEventListener('abort', () => reject(providerSignal?.reason), { once: true });
        });
      } },
    } as unknown as IPlatformAdapters;
    const server = new ChildIPCServer(platform, child);
    const transport = new IPCTransport();
    const controller = new AbortController();
    server.start();

    try {
      const call = new LLMProxy(transport).complete('single queued request', { signal: controller.signal });
      await waitFor(() => providerSignal !== undefined);
      await new Promise((resolve) => {
        setTimeout(resolve, 150);
      });
      expect(providerCalls).toBe(1);
      controller.abort(new DOMException('caller cancelled', 'AbortError'));
      await expect(call).rejects.toMatchObject({ name: 'AbortError' });
      await waitFor(() => providerSignal?.aborted === true);
      expect(providerSignal?.aborted).toBe(true);
    } finally {
      await transport.close();
      server.stop();
      if (processSendDescriptor) { Object.defineProperty(process, 'send', processSendDescriptor); }
      else { Reflect.deleteProperty(process, 'send'); }
    }
  });

  it('rejects a write on a real child pipe closed by the receiving process', async () => {
    const child = fork(fileURLToPath(new URL('./fixtures/close-stdin-child.cjs', import.meta.url)), [], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });
    const channel = createStdioChannel(child.stdout!, child.stdin!);

    try {
      await new Promise<void>((resolve, reject) => {
        child.once('message', (message: unknown) => { if (message === 'ready') { resolve(); } });
        child.once('error', reject);
        child.once('exit', (code) => { if (code !== 0) { reject(new Error(`Pipe fixture exited with ${code}`)); } });
      });
      await expect(channel.send({ type: 'platform:message', payload: 'x'.repeat(7 * 1024 * 1024) })).rejects.toBeInstanceOf(Error);
      expect(() => channel.close()).not.toThrow();
    } finally {
      channel.close();
      if (child.connected) { child.disconnect(); }
      child.kill();
    }
  });

  it('keeps the real pipe error owner through close while a queued write fails asynchronously', async () => {
    const child = fork(fileURLToPath(new URL('./fixtures/close-stdin-after-delay-child.cjs', import.meta.url)), [], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });
    const baselineErrorListeners = child.stdin!.listenerCount('error');
    const channel = createStdioChannel(child.stdout!, child.stdin!);
    let stdinClosed = false;
    child.on('message', (message: unknown) => { if (message === 'stdin-closed') { stdinClosed = true; } });
    let writableClosed = false;
    child.stdin!.once('close', () => { writableClosed = true; });

    try {
      await new Promise<void>((resolve, reject) => {
        child.once('message', (message: unknown) => { if (message === 'ready') { resolve(); } });
        child.once('error', reject);
      });
      const pipeFailure = new Promise<Error>((resolve) => {
        child.stdin!.once('error', resolve);
      });
      const pendingWrite = channel.send({ type: 'platform:message', payload: 'x'.repeat(7 * 1024 * 1024) });
      const writeOutcome = pendingWrite.then(
        () => ({ error: undefined }),
        (error: Error) => ({ error }),
      );
      expect(child.stdin!.writableNeedDrain).toBe(true);
      channel.close();
      expect((await writeOutcome).error).toMatchObject({ message: 'Stdio channel is closed' });
      expect(child.stdin!.listenerCount('error')).toBe(baselineErrorListeners + 2);

      await waitFor(() => stdinClosed);
      await expect(pipeFailure).resolves.toMatchObject({ code: 'EPIPE' });
      await waitFor(() => writableClosed);
      expect(child.stdin!.listenerCount('error')).toBe(baselineErrorListeners);
    } finally {
      channel.close();
      if (child.connected) { child.disconnect(); }
      child.kill();
    }
  });

  it('rejects process IPC sends through the callback after a real child disconnects', async () => {
    const processSendDescriptor = Object.getOwnPropertyDescriptor(process, 'send');
    const child = fork(fileURLToPath(new URL('./fixtures/disconnect-ipc-child.cjs', import.meta.url)), [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const ready = new Promise<void>((resolve, reject) => {
      child.once('message', (message: unknown) => {
        if (message === 'ready') { resolve(); } else { reject(new Error('IPC fixture sent an unexpected message')); }
      });
      child.once('error', reject);
    });
    const disconnected = new Promise<void>((resolve) => {
      child.once('disconnect', resolve);
    });
    const transport = new IPCTransport({ timeout: 5_000 });
    Object.defineProperty(process, 'send', {
      configurable: true,
      writable: true,
      value: child.send.bind(child),
    });

    try {
      await ready;
      await disconnected;
      await expect(new LLMProxy(transport).complete('disconnected child')).rejects.toMatchObject({ name: 'TransportError' });
    } finally {
      await transport.close();
      if (processSendDescriptor) { Object.defineProperty(process, 'send', processSendDescriptor); }
      else { Reflect.deleteProperty(process, 'send'); }
      if (child.connected) { child.disconnect(); }
      child.kill();
    }
  });
});
