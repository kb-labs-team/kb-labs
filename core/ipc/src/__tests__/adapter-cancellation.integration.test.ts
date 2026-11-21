import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { IPlatformAdapters } from '@kb-labs/core-platform';
import { LLMProxy, createStdioChannel, StdioPlatformServer, StdioTransport } from '../index.js';

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
      server.close();
      childChannel.close();
      hostChannel.close();
      childToHost.destroy();
      hostToChild.destroy();
    }
  });
});
