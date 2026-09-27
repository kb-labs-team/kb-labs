import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ILLM, ILLMRouter, LLMCapability, UseLLMOptions } from '@kb-labs/core-platform';
import { canUseLLM, canUseLLMForMessages, useLLM } from '../helpers/use-llm.js';

const { mockPlatform } = vi.hoisted(() => ({ mockPlatform: {} as Record<string, unknown> }));

vi.mock('../helpers/use-platform.js', () => ({
  usePlatform: () => mockPlatform,
}));

describe('useLLM cancellation propagation', () => {
  afterEach(() => {
    for (const key of Object.keys(mockPlatform)) {
      delete mockPlatform[key];
    }
  });

  it('preserves a non-enumerable signal through tier-bound tool calls', async () => {
    const adapterResponse = {
      content: 'done',
      model: 'test-model',
      usage: { promptTokens: 1, completionTokens: 1 },
    };
    const adapter: ILLM = {
      complete: vi.fn(async () => adapterResponse),
      stream: vi.fn(async function* () { yield 'done'; }),
      getProtocolCapabilities: () => ({ cache: { supported: true }, stream: { supported: false } }),
      chatWithTools: vi.fn(async () => adapterResponse),
    };
    const router = {
      complete: vi.fn(async () => adapterResponse),
      stream: vi.fn(async function* () { yield 'done'; }),
      getConfiguredTier: () => 'small' as const,
      resolve: () => ({
        provider: 'test',
        model: 'test-model',
        resource: 'llm:test',
        requestedTier: 'small' as const,
        actualTier: 'small' as const,
        adapted: false,
      }),
      resolveAdapter: async () => ({ adapter, model: 'test-model', tier: 'small' as const }),
      hasCapability: () => true,
      getCapabilities: () => [],
      supportsCapabilities: ({ capabilities = [] } = {}) => capabilities.every((cap) => cap === 'vision'),
    } satisfies ILLM & ILLMRouter;
    Object.assign(mockPlatform, { llm: router });

    const controller = new AbortController();
    const llm = useLLM({ tier: 'small' });
    const options = { tools: [] };
    Object.defineProperty(options, 'signal', { value: controller.signal, enumerable: false });
    await llm?.chatWithTools?.([], options);

    const passedOptions = (adapter.chatWithTools as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    expect(passedOptions?.signal).toBe(controller.signal);
    expect(Object.keys(passedOptions ?? {})).not.toContain('signal');
  });

  it('checks all requested capabilities through the router before binding', () => {
    const supportsCapabilities = vi.fn((options?: UseLLMOptions) =>
      (options?.capabilities ?? []).every((cap: LLMCapability) => cap === 'vision')
    );
    const router = {
      complete: vi.fn(),
      stream: vi.fn(async function* () {}),
      getConfiguredTier: () => 'large' as const,
      resolve: () => ({
        provider: 'test', model: 'test-model', resource: 'llm:test',
        requestedTier: 'large' as const, actualTier: 'large' as const, adapted: false,
      }),
      resolveAdapter: async () => ({ adapter: {} as ILLM, model: 'test-model', tier: 'large' as const }),
      hasCapability: () => true,
      getCapabilities: () => ['vision'] as const,
      supportsCapabilities,
    } satisfies ILLM & ILLMRouter;
    Object.assign(mockPlatform, { llm: router });

    expect(canUseLLM({ tier: 'large', capabilities: ['vision'] })).toBe(true);
    expect(canUseLLM({ tier: 'large', capabilities: ['fast', 'vision'] })).toBe(false);
    expect(supportsCapabilities).toHaveBeenCalledWith({ tier: 'large', capabilities: ['fast', 'vision'] });
  });

  it('infers required capabilities from content parts for preflight and dispatch', async () => {
    const supportsCapabilities = vi.fn(({ capabilities = [] }: UseLLMOptions = {}) =>
      capabilities.every((capability) => capability === 'vision')
    );
    const response = { content: 'done', model: 'test-model', usage: { promptTokens: 1, completionTokens: 1 } };
    const adapter: ILLM = {
      complete: vi.fn(async () => response),
      stream: vi.fn(async function* () { yield 'done'; }),
      getProtocolCapabilities: () => ({ cache: { supported: true }, stream: { supported: false } }),
      chatWithTools: vi.fn(async () => response),
    };
    const router = {
      complete: vi.fn(async () => response),
      stream: vi.fn(async function* () { yield 'done'; }),
      getConfiguredTier: () => 'large' as const,
      resolve: () => ({ provider: 'test', model: 'test-model', resource: 'llm:test', requestedTier: 'large' as const, actualTier: 'large' as const, adapted: false }),
      resolveAdapter: async () => ({ adapter, model: 'test-model', tier: 'large' as const }),
      hasCapability: () => true,
      getCapabilities: () => ['vision'] as const,
      supportsCapabilities,
    } satisfies ILLM & ILLMRouter;
    Object.assign(mockPlatform, { llm: router });

    const messages = [{
      role: 'user' as const,
      content: [{ type: 'image' as const, mediaType: 'image/png' as const, data: 'aGVsbG8=' }],
    }];
    expect(canUseLLMForMessages(messages, { tier: 'large' })).toBe(true);
    expect(supportsCapabilities).toHaveBeenLastCalledWith({ tier: 'large', capabilities: ['vision'] });

    await useLLM({ tier: 'large' })?.chatWithTools?.(messages, { tools: [] });
    expect(supportsCapabilities).toHaveBeenLastCalledWith({ tier: 'large', capabilities: ['vision'] });
    expect(adapter.chatWithTools).toHaveBeenCalledWith(messages, expect.anything());

    expect(canUseLLMForMessages([{
      role: 'assistant',
      content: [{ type: 'image', mediaType: 'image/png', data: 'aGVsbG8=' }],
    }])).toBe(false);
  });
});
