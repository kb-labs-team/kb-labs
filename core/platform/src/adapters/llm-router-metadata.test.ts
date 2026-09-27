import { describe, expect, it, vi } from 'vitest';
import type { ILLM } from './llm.js';
import { getLLMRouterMetadata } from './llm-router-metadata.js';

describe('getLLMRouterMetadata', () => {
  it('returns only resolved tier/model/capability metadata for worker proxies', async () => {
    const logger = { debug: vi.fn() };
    const llm = {
      getConfiguredTier: () => 'small',
      resolveAdapter: async ({ tier }: { tier: 'small' | 'medium' | 'large' }) => ({
        adapter: {} as ILLM,
        model: tier === 'small' ? 'gpt-6-luna' : 'gpt-6-sol',
        tier,
      }),
      supportsCapabilities: ({ capabilities }: { capabilities?: string[] }) =>
        capabilities?.[0] === 'vision',
      getCapabilities: () => ['vision'],
    } as unknown as ILLM;

    const metadata = await getLLMRouterMetadata(llm, logger);

    expect(metadata).toEqual({
      defaultTier: 'small',
      tierMapping: {
        small: [{ model: 'gpt-6-luna', priority: 1, capabilities: ['vision'] }],
        medium: [{ model: 'gpt-6-sol', priority: 1, capabilities: ['vision'] }],
        large: [{ model: 'gpt-6-sol', priority: 1, capabilities: ['vision'] }],
      },
      capabilities: ['vision'],
    });
    expect(logger.debug).toHaveBeenCalledOnce();
  });

  it('returns undefined for a non-router adapter', async () => {
    const llm = { complete: vi.fn() } as unknown as ILLM;
    await expect(getLLMRouterMetadata(llm)).resolves.toBeUndefined();
  });

  it('returns undefined when no LLM adapter is configured', async () => {
    await expect(getLLMRouterMetadata(undefined)).resolves.toBeUndefined();
  });
});
