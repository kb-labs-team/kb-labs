/**
 * @module @kb-labs/shared-command-kit/helpers/use-llm
 * Global LLM access helper with tier-based model selection.
 *
 * Provides clean access to LLM with adaptive tier routing.
 * Plugins specify tiers (small/medium/large), platform resolves to actual models.
 *
 * @example
 * ```typescript
 * import { useLLM } from '@kb-labs/shared-command-kit';
 *
 * async handler(ctx, argv, flags) {
 *   // Simple usage (uses configured default tier)
 *   const llm = useLLM();
 *
 *   // Request specific tier (platform adapts if needed)
 *   const llm = useLLM({ tier: 'small' });   // Simple tasks
 *   const llm = useLLM({ tier: 'large' });   // Complex tasks
 *
 *   // Request capabilities
 *   const llm = useLLM({ tier: 'medium', capabilities: ['code'] });
 *
 *   if (llm) {
 *     const result = await llm.complete('Explain this code');
 *     console.log(result.content);
 *   }
 * }
 * ```
 */

import { usePlatform } from './use-platform.js';
import type {
  ILLM,
  LLMTier,
  LLMOptions,
  LLMResponse,
  LLMMessage,
  LLMToolCallOptions,
  LLMToolCallResponse,
  UseLLMOptions,
  ILLMRouter,
  LLMAdapterBinding,
  LLMExecutionPolicy,
  LLMProtocolCapabilities,
  LLMCacheDecisionTrace,
  LLMCapability,
} from '@kb-labs/core-platform';
import { LLMContentValidationError, validateLLMContent } from '@kb-labs/core-platform';

/**
 * Access global LLM adapter with tier-based selection.
 *
 * Platform automatically adapts to available models:
 * - If plugin requests 'small' but 'medium' configured → uses 'medium' (escalation)
 * - If plugin requests 'large' but 'medium' configured → uses 'medium' with warning (degradation)
 *
 * **Tiers are user-defined slots:**
 * - `small`  - Plugin says: "This task is simple"
 * - `medium` - Plugin says: "Standard task"
 * - `large`  - Plugin says: "Complex task, need maximum quality"
 *
 * User decides what model maps to each tier in their config.
 *
 * @param options - Optional tier and capability requirements
 * @returns LLM adapter or undefined if not configured
 *
 * @example
 * ```typescript
 * // Simple usage (uses configured default)
 * const llm = useLLM();
 *
 * // Request specific tier
 * const llm = useLLM({ tier: 'small' });   // Simple tasks
 * const llm = useLLM({ tier: 'large' });   // Complex tasks
 *
 * // Request capabilities
 * const llm = useLLM({ tier: 'medium', capabilities: ['code'] });
 * const llm = useLLM({ capabilities: ['vision'] });
 *
 * if (llm) {
 *   const result = await llm.complete('Generate commit message');
 *   console.log(result.content);
 * }
 * ```
 */
export function useLLM(options?: UseLLMOptions): ILLM | undefined {
  const platform = usePlatform();
  const llm = platform.llm;

  if (!llm) {
    return undefined;
  }

  // If router and options given → return immutable LazyBoundLLM (no state mutation)
  if (options && isLLMRouter(llm)) {
    return new LazyBoundLLM(llm, options);
  }

  return llm;
}

/**
 * Lazy adapter binding that resolves tier on first use.
 * Immutable — does NOT mutate the global LLMRouter state.
 * This fixes the race condition where useLLM({ tier: 'large' }) was immediately
 * overwritten by useLLM({ tier: 'small' }) from SmartSummarizer.
 */
class LazyBoundLLM implements ILLM {
  private readonly _resolved = new Map<string, Promise<LLMAdapterBinding>>();

  constructor(
    private readonly router: ILLM & ILLMRouter,
    private readonly options: UseLLMOptions,
  ) {}

  private resolve(additionalCapabilities: LLMCapability[] = []): Promise<LLMAdapterBinding> {
    const capabilities = [...new Set([...(this.options.capabilities ?? []), ...additionalCapabilities])].sort();
    const key = `${this.options.tier ?? ''}:${capabilities.join(',')}`;
    let resolved = this._resolved.get(key);
    if (!resolved) {
      resolved = this.router.resolveAdapter({ ...this.options, capabilities });
      this._resolved.set(key, resolved);
    }
    return resolved;
  }

  private mergeExecutionPolicy(callOptions?: LLMOptions): LLMExecutionPolicy | undefined {
    const globalPolicy = this.options.execution;
    const localPolicy = callOptions?.execution;
    if (!globalPolicy && !localPolicy) {
      return undefined;
    }
    return {
      ...globalPolicy,
      ...localPolicy,
      cache: { ...globalPolicy?.cache, ...localPolicy?.cache },
      stream: { ...globalPolicy?.stream, ...localPolicy?.stream },
    };
  }

  private async resolveProtocolCapabilities(adapter: ILLM): Promise<LLMProtocolCapabilities> {
    if (!adapter.getProtocolCapabilities) {
      return {
        cache: { supported: false },
        stream: { supported: true },
      };
    }
    return adapter.getProtocolCapabilities();
  }

  private enforceCachePolicy(caps: LLMProtocolCapabilities, execution?: LLMExecutionPolicy): void {
    if (execution?.cache?.mode === 'require' && !caps.cache.supported) {
      throw new Error('CACHE_NOT_SUPPORTED: adapter does not support required cache policy');
    }
  }

  private buildDecisionTrace(
    caps: LLMProtocolCapabilities,
    execution: LLMExecutionPolicy | undefined,
    streamAppliedMode: 'prefer' | 'require' | 'off',
    streamFallback?: 'complete',
    reason?: string,
  ): LLMCacheDecisionTrace {
    const requestedCacheMode = execution?.cache?.mode ?? 'prefer';
    const requestedStreamMode = execution?.stream?.mode ?? 'prefer';

    return {
      cacheRequestedMode: requestedCacheMode,
      cacheSupported: caps.cache.supported,
      cacheAppliedMode:
        requestedCacheMode === 'require' || requestedCacheMode === 'bypass'
          ? requestedCacheMode
          : caps.cache.supported
            ? 'prefer'
            : 'bypass',
      streamRequestedMode: requestedStreamMode,
      streamSupported: caps.stream.supported,
      streamAppliedMode,
      streamFallback,
      reason,
    };
  }

  private withDecisionMetadata(
    options: LLMOptions | undefined,
    trace: LLMCacheDecisionTrace,
  ): LLMOptions | undefined {
    if (!options) {
      return { metadata: { cacheDecisionTrace: trace } };
    }

    return preserveAbortSignal(options, {
      ...options,
      metadata: {
        ...options.metadata,
        cacheDecisionTrace: trace,
      },
    });
  }

  async complete(prompt: string, options?: LLMOptions): Promise<LLMResponse> {
    const { adapter, model } = await this.resolve();
    const execution = this.mergeExecutionPolicy(options);
    const caps = await this.resolveProtocolCapabilities(adapter);
    this.enforceCachePolicy(caps, execution);
    const trace = this.buildDecisionTrace(caps, execution, 'off');
    const optionsWithTrace = this.withDecisionMetadata(options, trace);
    return adapter.complete(prompt, preserveAbortSignal(optionsWithTrace, { ...optionsWithTrace, model, execution }));
  }

  async *stream(prompt: string, options?: LLMOptions): AsyncIterable<string> {
    const { adapter, model } = await this.resolve();
    const execution = this.mergeExecutionPolicy(options);
    const caps = await this.resolveProtocolCapabilities(adapter);
    this.enforceCachePolicy(caps, execution);

    const streamMode = execution?.stream?.mode ?? 'prefer';
    const canStream = caps.stream.supported;
    const allowFallback = execution?.stream?.fallbackToComplete ?? true;

    if (streamMode === 'off' || (!canStream && streamMode === 'prefer' && allowFallback)) {
      const fallbackReason =
        streamMode === 'off'
          ? 'STREAM_OFF'
          : 'STREAM_UNSUPPORTED_FALLBACK_TO_COMPLETE';
      const trace = this.buildDecisionTrace(caps, execution, 'off', 'complete', fallbackReason);
      const optionsWithTrace = this.withDecisionMetadata(options, trace);
      const response = await adapter.complete(
        prompt,
        preserveAbortSignal(optionsWithTrace, { ...optionsWithTrace, model, execution }),
      );
      if (response.content) {
        yield response.content;
      }
      return;
    }

    if (!canStream && streamMode === 'require') {
      throw new Error('STREAM_NOT_SUPPORTED: adapter does not support required streaming');
    }

    const trace = this.buildDecisionTrace(caps, execution, streamMode);
    const optionsWithTrace = this.withDecisionMetadata(options, trace);
    yield* adapter.stream(
      prompt,
      preserveAbortSignal(optionsWithTrace, { ...optionsWithTrace, model, execution }),
    );
  }

  async chatWithTools(
    messages: LLMMessage[],
    options: LLMToolCallOptions,
  ): Promise<LLMToolCallResponse> {
    const requiredCapabilities = new Set<LLMCapability>();
    const validatedMessages = messages.map((message) => {
      const validated = validateLLMContent(message.role, message.content);
      validated.requiredCapabilities.forEach((capability) => requiredCapabilities.add(capability));
      return { ...message, content: validated.content };
    });
    const { adapter, model, tier } = await this.resolve([...requiredCapabilities]);
    const execution = this.mergeExecutionPolicy(options);
    const caps = await this.resolveProtocolCapabilities(adapter);
    this.enforceCachePolicy(caps, execution);
    if (!adapter.chatWithTools) {
      throw new Error('Current adapter does not support chatWithTools');
    }
    const trace = this.buildDecisionTrace(caps, execution, 'off');
    const optionsWithTrace = this.withDecisionMetadata(options, trace) as LLMToolCallOptions;
    return adapter.chatWithTools(validatedMessages, preserveAbortSignal(optionsWithTrace, {
      ...optionsWithTrace,
      model,
      execution,
      metadata: { ...optionsWithTrace.metadata, tier },
    }));
  }
}

function preserveAbortSignal<T extends object>(source: LLMOptions | undefined, target: T): T {
  if (source?.signal) {
    Object.defineProperty(target, 'signal', { value: source.signal, enumerable: false });
  }
  return target;
}

/**
 * Check if LLM is available.
 *
 * Useful for conditional logic (LLM-powered vs deterministic fallback).
 *
 * @returns true if LLM is configured and ready
 *
 * @example
 * ```typescript
 * if (isLLMAvailable()) {
 *   const summary = await generateWithLLM(data);
 * } else {
 *   const summary = generateDeterministic(data);
 * }
 * ```
 */
export function isLLMAvailable(): boolean {
  const llm = useLLM();
  return !!llm;
}

/**
 * Check whether an LLM is configured with one model satisfying every
 * requested capability in the effective tier. Text-only requests need no
 * capability declaration.
 */
export function canUseLLM(options?: UseLLMOptions): boolean {
  const llm = usePlatform().llm;
  if (!llm) {
    return false;
  }
  if (!options?.capabilities?.length) {
    return true;
  }
  if (!isLLMRouter(llm) || typeof llm.supportsCapabilities !== 'function') {
    return false;
  }
  return llm.supportsCapabilities(options);
}

/** Preflight LLM availability and capabilities inferred from message content. */
export function canUseLLMForMessages(
  messages: Array<Pick<LLMMessage, 'role' | 'content'>>,
  options?: UseLLMOptions,
): boolean {
  const capabilities = new Set(options?.capabilities ?? []);
  try {
    for (const message of messages) {
      validateLLMContent(message.role, message.content).requiredCapabilities
        .forEach((capability) => capabilities.add(capability));
    }
  } catch (error) {
    if (error instanceof LLMContentValidationError) {
      return false;
    }
    throw error;
  }
  return canUseLLM({ ...options, capabilities: [...capabilities] });
}

/**
 * Get configured LLM tier.
 *
 * Useful for diagnostics and logging.
 *
 * @returns Configured tier or undefined if LLM not available/not a router
 *
 * @example
 * ```typescript
 * const tier = getLLMTier();
 * console.log(`Using LLM tier: ${tier ?? 'default'}`);
 * ```
 */
export function getLLMTier(): LLMTier | undefined {
  const platform = usePlatform();
  const llm = platform.llm;

  if (llm && isLLMRouter(llm)) {
    return llm.getConfiguredTier();
  }

  return undefined;
}

/**
 * Type guard for ILLMRouter.
 */
function isLLMRouter(llm: ILLM): llm is ILLM & ILLMRouter {
  return (
    typeof (llm as unknown as ILLMRouter).getConfiguredTier === 'function' &&
    typeof (llm as unknown as ILLMRouter).resolve === 'function'
  );
}

// Re-export types for convenience
export {
  LLM_CAPABILITIES,
  LLM_CONTRACT,
  LLMContentValidationError,
  validateLLMContent,
  getLLMContentText,
} from '@kb-labs/core-platform';
export type {
  LLMTier,
  LLMCapability,
  LLMCapabilityCategory,
  LLMCapabilityDefinition,
  LLMContent,
  LLMContentPart,
  UseLLMOptions,
} from '@kb-labs/core-platform';
