import { describe, expect, it, vi } from 'vitest';
import type { LLMRouterMetadata } from '@kb-labs/core-platform';
import type { AdapterCall, AdapterResponse, SerializableError } from '@kb-labs/core-platform/serializable';
import type { ITransport } from '../transport/transport.js';
import { LLMProxy } from '../proxy/llm-proxy.js';
import { serialize } from '@kb-labs/core-platform/serializable';

describe('LLMProxy capability metadata', () => {
  const transport = {} as ITransport;
  const routing: LLMRouterMetadata = {
    defaultTier: 'small' as const,
    tierMapping: {
      small: [{ model: 'gpt-6-luna', priority: 1, capabilities: ['fast', 'vision'] }],
      medium: [{ model: 'gpt-6-sol', priority: 1, capabilities: ['reasoning', 'vision'] }],
    },
  };

  it('preflights capabilities from the configured worker-side tier mapping', () => {
    const llm = new LLMProxy(transport, routing);

    expect(llm.getConfiguredTier()).toBe('small');
    expect(llm.getCapabilities()).toEqual(['fast', 'vision', 'reasoning']);
    expect(llm.supportsCapabilities({ tier: 'small', capabilities: ['vision'] })).toBe(true);
    expect(llm.supportsCapabilities({ tier: 'small', capabilities: ['reasoning'] })).toBe(false);
    expect(llm.supportsCapabilities({ tier: 'medium', capabilities: ['vision', 'reasoning'] })).toBe(true);
  });

  it('resolves a configured model to a remote binding while preserving capability validation', async () => {
    const llm = new LLMProxy(transport, routing);
    const binding = await llm.resolveAdapter({ tier: 'medium', capabilities: ['vision'] });

    expect(binding).toMatchObject({ model: 'gpt-6-sol', tier: 'medium' });
    expect(binding.adapter).toBe(llm);
    expect(() => llm.resolve({ tier: 'small', capabilities: ['reasoning'] })).toThrow(/LLM_CAPABILITY_NOT_SUPPORTED/);
  });

  it('sends a cancellation control message without serializing AbortSignal', async () => {
    let resolveResponse!: (response: AdapterResponse) => void;
    let requestId = '';
    const sendMessage = vi.fn((message: unknown) => {
      const cancel = message as { requestId: string };
      expect(cancel).toMatchObject({ type: 'adapter:cancel', requestId });
      resolveResponse({ type: 'adapter:response', requestId, error: serialize(new Error('request cancelled')) as SerializableError });
    });
    const requestTransport: ITransport = {
      send: vi.fn((call: AdapterCall): Promise<AdapterResponse> => {
        requestId = call.requestId;
        return new Promise((resolve) => { resolveResponse = resolve; });
      }),
      sendMessage,
      onPushMessage: () => () => {},
      close: async () => {},
      isClosed: () => false,
    };
    const controller = new AbortController();
    const llm = new LLMProxy(requestTransport);
    const pending = llm.complete('prompt', { signal: controller.signal });
    await vi.waitFor(() => expect(requestId).not.toBe(''));
    const call = vi.mocked(requestTransport.send).mock.calls[0]![0];
    expect(JSON.stringify(call.args)).not.toContain('AbortSignal');

    controller.abort();
    await expect(pending).rejects.toThrow('request cancelled');
    expect(sendMessage).toHaveBeenCalledOnce();
  });
});
