import { describe, expect, it } from 'vitest';
import type { LLMRouterMetadata } from '@kb-labs/core-platform';
import type { ITransport } from '../transport/transport.js';
import { LLMProxy } from '../proxy/llm-proxy.js';

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
});
