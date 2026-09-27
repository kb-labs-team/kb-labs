/**
 * @module @kb-labs/llm-router/test/router
 * Unit tests for LLMRouter with tierMapping support.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LLMRouter, type TierMapping, type AdapterLoader } from '../src/router.js';
import type { ILLM, LLMResponse, ILogger } from '@kb-labs/core-platform';

// Mock ILLM adapter
function createMockAdapter(): ILLM {
  return {
    complete: vi.fn().mockResolvedValue({
      content: 'mock response',
      model: 'mock-model',
      usage: { promptTokens: 10, completionTokens: 20 },
    } satisfies LLMResponse),
    stream: vi.fn().mockImplementation(async function* () {
      yield 'chunk';
    }),
  };
}

// Mock logger
function createMockLogger(): ILogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as ILogger;
}

describe('LLMRouter', () => {
  let mockAdapter: ILLM;
  let mockLogger: ILogger;

  beforeEach(() => {
    mockAdapter = createMockAdapter();
    mockLogger = createMockLogger();
  });

  describe('basic initialization', () => {
    it('should initialize with simple config (no tierMapping)', () => {
      const router = new LLMRouter(
        mockAdapter,
        { defaultTier: 'medium' },
        mockLogger
      );

      expect(router.getConfiguredTier()).toBe('medium');
      expect(router.getCurrentModel()).toBeUndefined();
    });

    it('should use legacy tier field if defaultTier not provided', () => {
      const router = new LLMRouter(
        mockAdapter,
        { defaultTier: 'small', tier: 'large' }, // defaultTier takes precedence
        mockLogger
      );

      expect(router.getConfiguredTier()).toBe('small');
    });
  });

  describe('tierMapping initialization', () => {
    it('should select model from defaultTier on initialization', () => {
      const tierMapping: TierMapping = {
        small: [{ model: 'gpt-4o-mini', priority: 1 }],
        medium: [{ model: 'claude-sonnet-4-5', priority: 1 }],
        large: [{ model: 'claude-opus-4-5', priority: 1 }],
      };

      const router = new LLMRouter(
        mockAdapter,
        { defaultTier: 'medium', tierMapping },
        mockLogger
      );

      expect(router.getCurrentModel()).toBe('claude-sonnet-4-5');
    });

    it('should select highest priority model (lowest priority number)', () => {
      const tierMapping: TierMapping = {
        medium: [
          { model: 'gpt-5-codex', priority: 2 },
          { model: 'claude-sonnet-4-5', priority: 1 },
        ],
      };

      const router = new LLMRouter(
        mockAdapter,
        { defaultTier: 'medium', tierMapping },
        mockLogger
      );

      expect(router.getCurrentModel()).toBe('claude-sonnet-4-5');
    });

    it('should extract capabilities from tierMapping', () => {
      const tierMapping: TierMapping = {
        small: [{ model: 'gpt-4o-mini', priority: 1, capabilities: ['fast'] }],
        medium: [{ model: 'claude-sonnet', priority: 1, capabilities: ['code', 'reasoning'] }],
        large: [{ model: 'claude-opus', priority: 1, capabilities: ['vision'] }],
      };

      const router = new LLMRouter(
        mockAdapter,
        { defaultTier: 'medium', tierMapping },
        mockLogger
      );

      expect(router.hasCapability('fast')).toBe(true);
      expect(router.hasCapability('code')).toBe(true);
      expect(router.hasCapability('reasoning')).toBe(true);
      expect(router.hasCapability('vision')).toBe(true);
    });
  });

  describe('resolve() with tierMapping', () => {
    const tierMapping: TierMapping = {
      small: [{ model: 'gpt-4o-mini', priority: 1, capabilities: ['fast'] }],
      medium: [
        { model: 'claude-sonnet-4-5', priority: 1, capabilities: ['code', 'reasoning', 'vision'] },
        { model: 'gpt-5-codex', priority: 2, capabilities: ['code'] },
      ],
      large: [
        { model: 'claude-opus-4-5', priority: 1, capabilities: ['reasoning', 'code', 'vision'] },
        { model: 'gpt-5.1-codex-max', priority: 2, capabilities: ['reasoning', 'code'] },
      ],
    };

    it('should resolve to correct model for each tier', () => {
      const router = new LLMRouter(
        mockAdapter,
        { defaultTier: 'medium', tierMapping },
        mockLogger
      );

      // Resolve small
      let resolution = router.resolve({ tier: 'small' });
      expect(resolution.model).toBe('gpt-4o-mini');
      expect(resolution.actualTier).toBe('small');
      expect(router.getCurrentModel()).toBe('gpt-4o-mini');

      // Resolve large
      resolution = router.resolve({ tier: 'large' });
      expect(resolution.model).toBe('claude-opus-4-5');
      expect(resolution.actualTier).toBe('large');
      expect(router.getCurrentModel()).toBe('claude-opus-4-5');

      // Resolve medium
      resolution = router.resolve({ tier: 'medium' });
      expect(resolution.model).toBe('claude-sonnet-4-5');
      expect(resolution.actualTier).toBe('medium');
      expect(router.getCurrentModel()).toBe('claude-sonnet-4-5');
    });

    it('should resolve to default tier when no tier specified', () => {
      const router = new LLMRouter(
        mockAdapter,
        { defaultTier: 'large', tierMapping },
        mockLogger
      );

      const resolution = router.resolve();
      expect(resolution.model).toBe('claude-opus-4-5');
      expect(resolution.actualTier).toBe('large');
    });

    it('should filter by capabilities when specified', () => {
      const router = new LLMRouter(
        mockAdapter,
        { defaultTier: 'medium', tierMapping },
        mockLogger
      );

      // Request medium with 'code' capability - both have it, so first wins
      let resolution = router.resolve({ tier: 'medium', capabilities: ['code'] });
      expect(resolution.model).toBe('claude-sonnet-4-5');

      // Request large with 'vision' capability - only claude-opus has it
      resolution = router.resolve({ tier: 'large', capabilities: ['vision'] });
      expect(resolution.model).toBe('claude-opus-4-5');
    });

    it('should throw when no model declares every requested capability', () => {
      const router = new LLMRouter(
        mockAdapter,
        { defaultTier: 'medium', tierMapping },
        mockLogger
      );

      // small declares only fast, so it cannot satisfy fast + vision.
      expect(() => router.resolve({ tier: 'small', capabilities: ['fast', 'vision'] }))
        .toThrowError(/LLM_CAPABILITY_NOT_SUPPORTED.*fast, vision/s);
    });

    it('should reject a partial capability match instead of selecting the model', async () => {
      const router = new LLMRouter(
        mockAdapter,
        {
          defaultTier: 'large',
          tierMapping: {
            large: [{ model: 'video-only', priority: 1, capabilities: ['video.input'] }],
          },
        },
        mockLogger
      );

      await expect(
        router.resolveAdapter({ tier: 'large', capabilities: ['fast', 'video.input'] })
      ).rejects.toMatchObject({
        name: 'LLMCapabilityNotSupportedError',
        code: 'LLM_CAPABILITY_NOT_SUPPORTED',
        tier: 'large',
        requiredCapabilities: ['fast', 'video.input'],
        candidates: [{ model: 'video-only', capabilities: ['video.input'] }],
      });
    });

    it('should preflight the complete capability set on one model', () => {
      const router = new LLMRouter(
        mockAdapter,
        {
          defaultTier: 'large',
          tierMapping: {
            large: [{ model: 'video-only', priority: 1, capabilities: ['video.input'] }],
          },
        },
        mockLogger
      );

      expect(router.supportsCapabilities({ tier: 'large', capabilities: ['video.input'] })).toBe(true);
      expect(router.supportsCapabilities({ tier: 'large', capabilities: ['fast', 'video.input'] })).toBe(false);
    });
  });

  describe('ILLM delegation with model injection', () => {
    const tierMapping: TierMapping = {
      small: [{ model: 'gpt-4o-mini', priority: 1 }],
      medium: [{ model: 'claude-sonnet-4-5', priority: 1 }],
    };

    it('should pass selected model to complete()', async () => {
      const router = new LLMRouter(
        mockAdapter,
        { defaultTier: 'medium', tierMapping },
        mockLogger
      );

      await router.complete('Hello');

      expect(mockAdapter.complete).toHaveBeenCalledWith(
        'Hello',
        expect.objectContaining({
          model: 'claude-sonnet-4-5',
          metadata: expect.objectContaining({ tier: 'medium' }),
        })
      );
    });

    it('should pass selected model after resolve()', async () => {
      const router = new LLMRouter(
        mockAdapter,
        { defaultTier: 'medium', tierMapping },
        mockLogger
      );

      // Resolve to small
      router.resolve({ tier: 'small' });

      await router.complete('Hello');

      expect(mockAdapter.complete).toHaveBeenCalledWith(
        'Hello',
        expect.objectContaining({
          model: 'gpt-4o-mini',
          metadata: expect.objectContaining({ tier: 'small' }),
        })
      );
    });

    it('should preserve other options when injecting model', async () => {
      const router = new LLMRouter(
        mockAdapter,
        { defaultTier: 'medium', tierMapping },
        mockLogger
      );

      await router.complete('Hello', { temperature: 0.7, maxTokens: 100 });

      expect(mockAdapter.complete).toHaveBeenCalledWith(
        'Hello',
        expect.objectContaining({
          model: 'claude-sonnet-4-5',
          temperature: 0.7,
          maxTokens: 100,
          metadata: expect.objectContaining({ tier: 'medium' }),
        })
      );
    });

    it('should not override explicitly provided model', async () => {
      const router = new LLMRouter(
        mockAdapter,
        { defaultTier: 'medium', tierMapping },
        mockLogger
      );

      await router.complete('Hello', { model: 'custom-model' });

      expect(mockAdapter.complete).toHaveBeenCalledWith(
        'Hello',
        expect.objectContaining({
          model: 'custom-model',
          metadata: expect.objectContaining({ tier: 'medium' }),
        })
      );
    });

    it('should pass model to stream()', async () => {
      const router = new LLMRouter(
        mockAdapter,
        { defaultTier: 'medium', tierMapping },
        mockLogger
      );

      // Consume the stream
      const chunks: string[] = [];
      for await (const chunk of router.stream('Hello')) {
        chunks.push(chunk);
      }

      expect(mockAdapter.stream).toHaveBeenCalledWith(
        'Hello',
        expect.objectContaining({
          model: 'claude-sonnet-4-5',
          metadata: expect.objectContaining({ tier: 'medium' }),
        })
      );
    });
  });

  describe('edge cases', () => {
    it('should handle empty tierMapping gracefully', () => {
      const router = new LLMRouter(
        mockAdapter,
        { defaultTier: 'medium', tierMapping: {} },
        mockLogger
      );

      expect(router.getCurrentModel()).toBeUndefined();

      const resolution = router.resolve({ tier: 'medium' });
      expect(resolution.model).toBe('default');
    });

    it('should handle missing tier in tierMapping', () => {
      const tierMapping: TierMapping = {
        small: [{ model: 'gpt-4o-mini', priority: 1 }],
        // medium and large not defined
      };

      const router = new LLMRouter(
        mockAdapter,
        { defaultTier: 'medium', tierMapping },
        mockLogger
      );

      expect(router.getCurrentModel()).toBeUndefined();
    });

    it('should handle empty array for tier', () => {
      const tierMapping: TierMapping = {
        medium: [],
      };

      const router = new LLMRouter(
        mockAdapter,
        { defaultTier: 'medium', tierMapping },
        mockLogger
      );

      expect(router.getCurrentModel()).toBeUndefined();
    });

    it('should work without logger', () => {
      const tierMapping: TierMapping = {
        medium: [{ model: 'test-model', priority: 1 }],
      };

      const router = new LLMRouter(mockAdapter, { defaultTier: 'medium', tierMapping });

      expect(router.getCurrentModel()).toBe('test-model');
      expect(() => router.resolve({ tier: 'small' })).not.toThrow();
    });
  });

  describe('chatWithTools support', () => {
    it('should report supportsChatWithTools correctly', () => {
      const router = new LLMRouter(
        mockAdapter,
        { defaultTier: 'medium' },
        mockLogger
      );

      expect(router.supportsChatWithTools).toBe(false);
    });

    it('should delegate chatWithTools when available', async () => {
      const adapterWithTools: ILLM = {
        ...mockAdapter,
        chatWithTools: vi.fn().mockResolvedValue({
          content: 'response',
          toolCalls: [],
          model: 'test',
          usage: { promptTokens: 1, completionTokens: 1 },
        }),
      };

      const tierMapping: TierMapping = {
        medium: [{ model: 'claude-sonnet-4-5', priority: 1 }],
      };

      const router = new LLMRouter(
        adapterWithTools,
        { defaultTier: 'medium', tierMapping },
        mockLogger
      );

      expect(router.supportsChatWithTools).toBe(true);

      await router.chatWithTools(
        [{ role: 'user', content: 'Hello' }],
        { tools: [] }
      );

      expect(adapterWithTools.chatWithTools).toHaveBeenCalledWith(
        [{ role: 'user', content: 'Hello' }],
        expect.objectContaining({
          tools: [],
          model: 'claude-sonnet-4-5',
          metadata: expect.objectContaining({ tier: 'medium' }),
        })
      );
    });

    it('preserves a non-enumerable cancellation signal while adding routing metadata', async () => {
      const adapterWithTools: ILLM = {
        ...mockAdapter,
        chatWithTools: vi.fn().mockResolvedValue({
          content: 'response',
          toolCalls: [],
          model: 'test',
          usage: { promptTokens: 1, completionTokens: 1 },
        }),
      };
      const router = new LLMRouter(adapterWithTools, { defaultTier: 'medium' }, mockLogger);
      const controller = new AbortController();
      const options = { tools: [] };
      Object.defineProperty(options, 'signal', { value: controller.signal, enumerable: false });

      await router.chatWithTools([{ role: 'user', content: 'Hello' }], options);

      const passedOptions = (adapterWithTools.chatWithTools as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
      expect(passedOptions?.signal).toBe(controller.signal);
      expect(Object.keys(passedOptions ?? {})).not.toContain('signal');
    });
  });

  describe('multi-adapter support', () => {
    let openaiAdapter: ILLM;
    let vibeproxyAdapter: ILLM;
    let adapterLoader: AdapterLoader;

    beforeEach(() => {
      // Create distinct mock adapters for different providers
      openaiAdapter = {
        complete: vi.fn().mockResolvedValue({
          content: 'openai response',
          model: 'gpt-4o-mini',
          usage: { promptTokens: 10, completionTokens: 20 },
        } satisfies LLMResponse),
        stream: vi.fn().mockImplementation(async function* () {
          yield 'openai chunk';
        }),
      };

      vibeproxyAdapter = {
        complete: vi.fn().mockResolvedValue({
          content: 'vibeproxy response',
          model: 'claude-sonnet-4-5',
          usage: { promptTokens: 15, completionTokens: 25 },
        } satisfies LLMResponse),
        stream: vi.fn().mockImplementation(async function* () {
          yield 'vibeproxy chunk';
        }),
      };

      // Mock adapter loader that returns different adapters based on package name
      adapterLoader = vi.fn().mockImplementation(async (pkg: string) => {
        if (pkg === '@kb-labs/adapters-openai') {
          return openaiAdapter;
        } else if (pkg === '@kb-labs/adapters-vibeproxy') {
          return vibeproxyAdapter;
        }
        throw new Error(`Unknown adapter: ${pkg}`);
      });
    });

    it('should initialize with adapter from default tier', () => {
      const tierMapping: TierMapping = {
        small: [{ adapter: '@kb-labs/adapters-openai', model: 'gpt-4o-mini', priority: 1 }],
        medium: [{ adapter: '@kb-labs/adapters-vibeproxy', model: 'claude-sonnet-4-5', priority: 1 }],
      };

      const router = new LLMRouter(
        mockAdapter,
        { defaultTier: 'small', tierMapping, adapterLoader },
        mockLogger
      );

      expect(router.getCurrentModel()).toBe('gpt-4o-mini');
      expect(router.getCurrentAdapterPackage()).toBe('@kb-labs/adapters-openai');
    });

    it('should switch adapter when resolving to different tier', () => {
      const tierMapping: TierMapping = {
        small: [{ adapter: '@kb-labs/adapters-openai', model: 'gpt-4o-mini', priority: 1 }],
        medium: [{ adapter: '@kb-labs/adapters-vibeproxy', model: 'claude-sonnet-4-5', priority: 1 }],
        large: [{ adapter: '@kb-labs/adapters-vibeproxy', model: 'claude-opus-4-5', priority: 1 }],
      };

      const router = new LLMRouter(
        mockAdapter,
        { defaultTier: 'small', tierMapping, adapterLoader },
        mockLogger
      );

      // Initially on small tier with openai adapter
      expect(router.getCurrentAdapterPackage()).toBe('@kb-labs/adapters-openai');

      // Resolve to medium - should switch to vibeproxy
      router.resolve({ tier: 'medium' });
      expect(router.getCurrentAdapterPackage()).toBe('@kb-labs/adapters-vibeproxy');
      expect(router.getCurrentModel()).toBe('claude-sonnet-4-5');

      // Resolve to large - same adapter, different model
      router.resolve({ tier: 'large' });
      expect(router.getCurrentAdapterPackage()).toBe('@kb-labs/adapters-vibeproxy');
      expect(router.getCurrentModel()).toBe('claude-opus-4-5');
    });

    it('should load adapter on first complete() call', async () => {
      const tierMapping: TierMapping = {
        small: [{ adapter: '@kb-labs/adapters-openai', model: 'gpt-4o-mini', priority: 1 }],
      };

      const router = new LLMRouter(
        mockAdapter,
        { defaultTier: 'small', tierMapping, adapterLoader },
        mockLogger
      );

      // Adapter loader should not be called yet
      expect(adapterLoader).not.toHaveBeenCalled();

      // Call complete - should load adapter
      await router.complete('Hello');

      expect(adapterLoader).toHaveBeenCalledWith('@kb-labs/adapters-openai');
      expect(openaiAdapter.complete).toHaveBeenCalledWith(
        'Hello',
        expect.objectContaining({
          model: 'gpt-4o-mini',
          metadata: expect.objectContaining({ tier: 'small', provider: 'openai' }),
        })
      );
    });

    it('should cache loaded adapters', async () => {
      const tierMapping: TierMapping = {
        small: [{ adapter: '@kb-labs/adapters-openai', model: 'gpt-4o-mini', priority: 1 }],
      };

      const router = new LLMRouter(
        mockAdapter,
        { defaultTier: 'small', tierMapping, adapterLoader },
        mockLogger
      );

      // Call complete multiple times
      await router.complete('Hello');
      await router.complete('World');
      await router.complete('Test');

      // Adapter loader should only be called once (cached)
      expect(adapterLoader).toHaveBeenCalledTimes(1);
    });

    it('should use correct adapter for each tier', async () => {
      const tierMapping: TierMapping = {
        small: [{ adapter: '@kb-labs/adapters-openai', model: 'gpt-4o-mini', priority: 1 }],
        medium: [{ adapter: '@kb-labs/adapters-vibeproxy', model: 'claude-sonnet-4-5', priority: 1 }],
      };

      const router = new LLMRouter(
        mockAdapter,
        { defaultTier: 'small', tierMapping, adapterLoader },
        mockLogger
      );

      // Use small tier
      await router.complete('Hello small');
      expect(openaiAdapter.complete).toHaveBeenCalledWith(
        'Hello small',
        expect.objectContaining({
          model: 'gpt-4o-mini',
          metadata: expect.objectContaining({ tier: 'small', provider: 'openai' }),
        })
      );

      // Switch to medium tier
      router.resolve({ tier: 'medium' });
      await router.complete('Hello medium');
      expect(vibeproxyAdapter.complete).toHaveBeenCalledWith(
        'Hello medium',
        expect.objectContaining({
          model: 'claude-sonnet-4-5',
          metadata: expect.objectContaining({ tier: 'medium', provider: 'vibeproxy' }),
        })
      );
    });

    it('should include provider and resource in resolution result', () => {
      const tierMapping: TierMapping = {
        small: [{ adapter: '@kb-labs/adapters-openai', model: 'gpt-4o-mini', priority: 1 }],
        medium: [{ adapter: '@kb-labs/adapters-vibeproxy', model: 'claude-sonnet-4-5', priority: 1 }],
      };

      const router = new LLMRouter(
        mockAdapter,
        { defaultTier: 'small', tierMapping, adapterLoader },
        mockLogger
      );

      const smallResolution = router.resolve({ tier: 'small' });
      expect(smallResolution.provider).toBe('openai');
      expect(smallResolution.resource).toBe('llm:openai');

      const mediumResolution = router.resolve({ tier: 'medium' });
      expect(mediumResolution.provider).toBe('vibeproxy');
      expect(mediumResolution.resource).toBe('llm:vibeproxy');
    });

    it('should extract provider from new provider field when specified', () => {
      const tierMapping: TierMapping = {
        small: [{ provider: 'openai', model: 'gpt-4o-mini', priority: 1 }],
        medium: [{ provider: 'anthropic', model: 'claude-sonnet-4-5', priority: 1 }],
      };

      const router = new LLMRouter(
        mockAdapter,
        { defaultTier: 'small', tierMapping },
        mockLogger
      );

      const smallResolution = router.resolve({ tier: 'small' });
      expect(smallResolution.provider).toBe('openai');
      expect(smallResolution.resource).toBe('llm:openai');

      const mediumResolution = router.resolve({ tier: 'medium' });
      expect(mediumResolution.provider).toBe('anthropic');
      expect(mediumResolution.resource).toBe('llm:anthropic');
    });

    it('should fall back to default adapter when adapter loader fails', async () => {
      const failingLoader: AdapterLoader = vi.fn().mockRejectedValue(new Error('Load failed'));

      const tierMapping: TierMapping = {
        small: [{ adapter: '@kb-labs/adapters-unknown', model: 'unknown-model', priority: 1 }],
      };

      const router = new LLMRouter(
        mockAdapter,
        { defaultTier: 'small', tierMapping, adapterLoader: failingLoader },
        mockLogger
      );

      // Should fall back to default adapter without throwing
      await router.complete('Hello');

      expect(failingLoader).toHaveBeenCalled();
      expect(mockAdapter.complete).toHaveBeenCalledWith(
        'Hello',
        expect.objectContaining({
          model: 'unknown-model',
          metadata: expect.objectContaining({
            tier: 'small',
            provider: 'unknown',
            resource: 'llm:unknown',
          }),
        })
      );
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('should use default adapter when no adapter specified in tierMapping', async () => {
      const tierMapping: TierMapping = {
        small: [{ model: 'gpt-4o-mini', priority: 1 }], // No adapter field
      };

      const router = new LLMRouter(
        mockAdapter,
        { defaultTier: 'small', tierMapping, adapterLoader },
        mockLogger
      );

      await router.complete('Hello');

      // Should use default adapter, not call loader
      expect(adapterLoader).not.toHaveBeenCalled();
      expect(mockAdapter.complete).toHaveBeenCalledWith(
        'Hello',
        expect.objectContaining({
          model: 'gpt-4o-mini',
          metadata: expect.objectContaining({
            tier: 'small',
            provider: 'default',
            resource: 'llm:default',
          }),
        })
      );
    });

    it('should work without adapterLoader (backward compatible)', async () => {
      const tierMapping: TierMapping = {
        small: [{ adapter: '@kb-labs/adapters-openai', model: 'gpt-4o-mini', priority: 1 }],
      };

      const router = new LLMRouter(
        mockAdapter,
        { defaultTier: 'small', tierMapping }, // No adapterLoader
        mockLogger
      );

      // Should use default adapter even though adapter is specified
      await router.complete('Hello');

      expect(mockAdapter.complete).toHaveBeenCalledWith(
        'Hello',
        expect.objectContaining({
          model: 'gpt-4o-mini',
          metadata: expect.objectContaining({
            tier: 'small',
            provider: 'openai',
            resource: 'llm:openai',
          }),
        })
      );
    });

    it('should handle stream() with multi-adapter', async () => {
      const tierMapping: TierMapping = {
        small: [{ adapter: '@kb-labs/adapters-openai', model: 'gpt-4o-mini', priority: 1 }],
      };

      const router = new LLMRouter(
        mockAdapter,
        { defaultTier: 'small', tierMapping, adapterLoader },
        mockLogger
      );

      const chunks: string[] = [];
      for await (const chunk of router.stream('Hello')) {
        chunks.push(chunk);
      }

      expect(adapterLoader).toHaveBeenCalledWith('@kb-labs/adapters-openai');
      expect(openaiAdapter.stream).toHaveBeenCalledWith(
        'Hello',
        expect.objectContaining({
          model: 'gpt-4o-mini',
          metadata: expect.objectContaining({
            tier: 'small',
            provider: 'openai',
            resource: 'llm:openai',
          }),
        })
      );
      expect(chunks).toEqual(['openai chunk']);
    });

    it('should handle chatWithTools() with multi-adapter', async () => {
      // Add chatWithTools to vibeproxy adapter
      const vibeproxyWithTools: ILLM = {
        ...vibeproxyAdapter,
        chatWithTools: vi.fn().mockResolvedValue({
          content: 'vibeproxy tool response',
          toolCalls: [],
          model: 'claude-sonnet-4-5',
          usage: { promptTokens: 20, completionTokens: 30 },
        }),
      };

      const adapterLoaderWithTools: AdapterLoader = vi.fn().mockImplementation(async (pkg: string) => {
        if (pkg === '@kb-labs/adapters-vibeproxy') {
          return vibeproxyWithTools;
        }
        throw new Error(`Unknown adapter: ${pkg}`);
      });

      const tierMapping: TierMapping = {
        medium: [{ adapter: '@kb-labs/adapters-vibeproxy', model: 'claude-sonnet-4-5', priority: 1 }],
      };

      const router = new LLMRouter(
        mockAdapter,
        { defaultTier: 'medium', tierMapping, adapterLoader: adapterLoaderWithTools },
        mockLogger
      );

      await router.chatWithTools(
        [{ role: 'user', content: 'Use tool' }],
        { tools: [] }
      );

      expect(adapterLoaderWithTools).toHaveBeenCalledWith('@kb-labs/adapters-vibeproxy');
      expect(vibeproxyWithTools.chatWithTools).toHaveBeenCalledWith(
        [{ role: 'user', content: 'Use tool' }],
        expect.objectContaining({
          tools: [],
          model: 'claude-sonnet-4-5',
          metadata: expect.objectContaining({
            tier: 'medium',
            provider: 'vibeproxy',
            resource: 'llm:vibeproxy',
          }),
        })
      );
    });
  });
});
