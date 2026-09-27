/**
 * @module @kb-labs/llm-router/router
 * LLM Router - adaptive routing with tier-based model selection.
 * Supports multiple adapters per tier for maximum flexibility.
 */

import type {
  ILLM,
  LLMOptions,
  LLMResponse,
  LLMMessage,
  LLMToolCallOptions,
  LLMToolCallResponse,
  LLMTier,
  LLMCapability,
  LLMModelEntry,
  LLMTierMapping,
  UseLLMOptions,
  LLMResolution,
  LLMAdapterBinding,
  ILLMRouter,
  ILogger,
  LLMRequestMetadata,
  LLMProtocolCapabilities,
} from '@kb-labs/core-platform';
import { LLMCapabilityNotSupportedError } from '@kb-labs/core-platform';
import { TierResolver, CapabilityResolver } from './resolver.js';

/**
 * Model entry in tier mapping.
 * Can optionally specify a different adapter per model.
 */
export type TierModelEntry = LLMModelEntry;

/**
 * Helper to extract provider from entry (supports both new `provider` and legacy `adapter`).
 */
function getProviderFromEntry(entry: TierModelEntry): string {
  // Prefer explicit provider
  if (entry.provider) {
    return entry.provider;
  }
  // Extract from adapter package name: "@kb-labs/adapters-openai" → "openai"
  const adapter = entry.adapter;
  if (adapter) {
    const match = adapter.match(/adapters-(\w+)/);
    if (match?.[1]) {
      return match[1];
    }
    // Fallback: use last segment
    const segments = adapter.split(/[-/]/);
    const lastSegment = segments[segments.length - 1];
    return lastSegment ?? 'default';
  }
  return 'default';
}

/**
 * Tier mapping configuration.
 */
export type TierMapping = LLMTierMapping;

/**
 * Function to load an adapter by package name.
 */
export type AdapterLoader = (adapterPackage: string) => Promise<ILLM>;

/**
 * LLM Router configuration.
 */
export interface LLMRouterConfig {
  /** Default tier when none specified */
  defaultTier: LLMTier;
  /** Tier to model mapping */
  tierMapping?: TierMapping;
  /** Function to load adapters by package name (required for multi-adapter) */
  adapterLoader?: AdapterLoader;
  /** Legacy: single tier (for simple config) */
  tier?: LLMTier;
  /** Legacy: available capabilities */
  capabilities?: LLMCapability[];
}

/**
 * Resolved entry with adapter and model.
 */
interface ResolvedEntry {
  entry: TierModelEntry;
  adapter: ILLM;
}

/**
 * LLM Router - wraps ILLM adapters with tier-based routing.
 *
 * Features:
 * - Adaptive tier resolution (escalation/degradation)
 * - Model selection from tierMapping
 * - Multi-adapter support (different adapters per tier/model)
 * - Capability-based filtering
 * - Transparent ILLM delegation
 *
 * @example
 * ```typescript
 * // Single adapter (simple)
 * const router = new LLMRouter(openaiAdapter, {
 *   defaultTier: 'medium',
 *   tierMapping: {
 *     small: [{ model: 'gpt-4o-mini', priority: 1 }],
 *     medium: [{ model: 'gpt-4o', priority: 1 }],
 *   }
 * }, logger);
 *
 * // Multi-adapter (different adapters per tier)
 * const router = new LLMRouter(defaultAdapter, {
 *   defaultTier: 'small',
 *   tierMapping: {
 *     small: [{ adapter: '@kb-labs/adapters-openai', model: 'gpt-4o-mini', priority: 1 }],
 *     medium: [{ adapter: '@kb-labs/adapters-vibeproxy', model: 'claude-sonnet-4-5', priority: 1 }],
 *     large: [{ adapter: '@kb-labs/adapters-vibeproxy', model: 'claude-opus-4-5', priority: 1 }],
 *   },
 *   adapterLoader: async (pkg) => loadAdapter(pkg),
 * }, logger);
 * ```
 */
export class LLMRouter implements ILLM, ILLMRouter {
  private tierResolver: TierResolver;
  private capabilityResolver: CapabilityResolver;
  private currentModel: string | undefined;
  private currentAdapter: ILLM;
  private currentAdapterPackage: string | undefined;
  /** Current tier for metadata */
  private currentTier: LLMTier;
  /** Current provider for metadata */
  private currentProvider: string = 'default';
  /** Current resource name for metadata */
  private currentResource: string = 'llm:default';

  /** Cache of loaded adapters by package name */
  private adapterCache: Map<string, ILLM> = new Map();

  constructor(
    private defaultAdapter: ILLM,
    private config: LLMRouterConfig,
    private logger?: ILogger
  ) {
    // Use defaultTier or legacy tier field
    const effectiveTier = config.defaultTier ?? config.tier ?? 'small';
    this.tierResolver = new TierResolver(effectiveTier);
    this.currentTier = effectiveTier;

    // Build capabilities from tierMapping or legacy config
    const allCapabilities = this.extractCapabilities();
    this.capabilityResolver = new CapabilityResolver(
      allCapabilities.size > 0 ? allCapabilities : undefined
    );

    // Set initial adapter and model from default tier
    this.currentAdapter = defaultAdapter;
    const entry = this.getEntryForTier(effectiveTier);
    if (entry) {
      this.currentModel = entry.model;
      this.currentAdapterPackage = entry.adapter;
      this.currentProvider = getProviderFromEntry(entry);
      this.currentResource = `llm:${this.currentProvider}`;
    }

    if (this.logger && this.currentModel) {
      this.logger.debug(
        `LLMRouter initialized: model=${this.currentModel}, provider=${this.currentProvider}`
      );
    }
  }

  /**
   * Extract all capabilities from tierMapping.
   */
  private extractCapabilities(): Set<LLMCapability> {
    const caps = new Set<LLMCapability>();

    if (this.config.tierMapping) {
      for (const entries of Object.values(this.config.tierMapping)) {
        if (entries) {
          for (const entry of entries) {
            if (entry.capabilities) {
              entry.capabilities.forEach((c: LLMCapability) => caps.add(c));
            }
          }
        }
      }
    }

    // Include legacy capabilities
    if (this.config.capabilities) {
      this.config.capabilities.forEach((c) => caps.add(c));
    }

    return caps;
  }

  /**
   * Get entry for a given tier (highest priority).
   */
  private getEntryForTier(
    tier: LLMTier,
    requiredCapabilities?: LLMCapability[]
  ): TierModelEntry | undefined {
    if (!this.config.tierMapping) {
      return undefined;
    }

    const entries = this.config.tierMapping[tier];
    if (!entries || entries.length === 0) {
      return undefined;
    }

    // Sort by priority (lower = higher priority)
    const sorted = [...entries].sort((a, b) => a.priority - b.priority);

    // If capabilities required, filter
    if (requiredCapabilities && requiredCapabilities.length > 0) {
      const matching = sorted.find((entry) =>
        requiredCapabilities.every((cap) => entry.capabilities?.includes(cap))
      );
      if (matching) {
        return matching;
      }
    }

    // Capability requirements are conjunctive. Never fall back to a model
    // that only satisfies part (or none) of the requested set.
    return requiredCapabilities && requiredCapabilities.length > 0 ? undefined : sorted[0];
  }

  private assertCapabilitiesSupported(tier: LLMTier, requiredCapabilities?: LLMCapability[]): void {
    if (!requiredCapabilities?.length) {
      return;
    }

    const entryMatches = this.config.tierMapping
      ? Boolean(this.getEntryForTier(tier, requiredCapabilities))
      : requiredCapabilities.every((capability) => this.config.capabilities?.includes(capability));
    if (entryMatches) {
      return;
    }

    const candidates = this.config.tierMapping
      ? (this.config.tierMapping[tier] ?? []).map((candidate) => ({
          model: candidate.model,
          capabilities: candidate.capabilities ?? [],
        }))
      : [{
          model: this.currentModel ?? 'default',
          capabilities: this.config.capabilities ?? [],
        }];

    throw new LLMCapabilityNotSupportedError(tier, requiredCapabilities, candidates);
  }

  /**
   * Get adapter for a given package (from cache or load).
   */
  private async getAdapter(adapterPackage?: string): Promise<ILLM> {
    // No package specified or no loader → use default
    if (!adapterPackage || !this.config.adapterLoader) {
      return this.defaultAdapter;
    }

    // Check cache
    const cached = this.adapterCache.get(adapterPackage);
    if (cached) {
      return cached;
    }

    // Load and cache
    try {
      const adapter = await this.config.adapterLoader(adapterPackage);
      this.adapterCache.set(adapterPackage, adapter);
      this.logger?.debug(`LLMRouter loaded adapter: ${adapterPackage}`);
      return adapter;
    } catch (error) {
      this.logger?.warn(`LLMRouter failed to load adapter ${adapterPackage}, using default`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return this.defaultAdapter;
    }
  }

  /**
   * Ensure current adapter is loaded (async).
   */
  private async ensureAdapter(): Promise<ILLM> {
    if (!this.currentAdapterPackage) {
      return this.defaultAdapter;
    }

    const adapter = await this.getAdapter(this.currentAdapterPackage);
    this.currentAdapter = adapter;
    return adapter;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ILLMRouter implementation
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Get configured default tier.
   */
  getConfiguredTier(): LLMTier {
    return this.config.defaultTier ?? this.config.tier ?? 'small';
  }

  /**
   * Resolve tier request to actual model and adapter.
   */
  resolve(options?: UseLLMOptions): LLMResolution {
    const requestedTier = options?.tier;
    const defaultTier = this.getConfiguredTier();

    // Determine which tier to use
    let actualTier: LLMTier;
    let adapted = false;
    let warning: string | undefined;

    if (this.config.tierMapping) {
      // With tierMapping: honor requested tier if it has models defined
      const tierToUse = requestedTier ?? defaultTier;
      const hasModels = (this.config.tierMapping[tierToUse]?.length ?? 0) > 0;

      if (hasModels) {
        actualTier = tierToUse;
        adapted = requestedTier !== undefined && requestedTier !== defaultTier;
      } else {
        // Fall back to default tier if requested tier has no models
        actualTier = defaultTier;
        adapted = requestedTier !== undefined;
        if (requestedTier && requestedTier !== defaultTier) {
          warning = `Requested '${requestedTier}' tier has no models configured. Using '${actualTier}'.`;
          if (this.logger) {
            this.logger.warn(warning);
          }
        }
      }
    } else {
      // Without tierMapping: use legacy TierResolver logic
      const tierResult = this.tierResolver.resolve(requestedTier);
      actualTier = tierResult.tier;
      adapted = tierResult.adapted;
      warning = tierResult.warning;

      if (warning && this.logger) {
        this.logger.warn(warning);
      }
    }

    // Get entry for the actual tier
    this.assertCapabilitiesSupported(actualTier, options?.capabilities);
    const entry = this.getEntryForTier(actualTier, options?.capabilities);
    const model = entry?.model;
    const adapterPackage = entry?.adapter;
    const provider = entry ? getProviderFromEntry(entry) : 'default';
    const resource = `llm:${provider}`;

    // Update current state for subsequent calls
    this.currentTier = actualTier;
    this.currentProvider = provider;
    this.currentResource = resource;
    if (model) {
      this.currentModel = model;
      this.currentAdapterPackage = adapterPackage;
      if (this.logger) {
        this.logger.debug(
          `LLMRouter resolved: tier=${actualTier}, model=${model}, provider=${provider}, resource=${resource}`
        );
      }
    }

    return {
      provider,
      model: model ?? 'default',
      resource,
      requestedTier: requestedTier,
      actualTier: actualTier,
      adapted: adapted,
      warning: warning,
    };
  }

  /**
   * Check if capability is available.
   */
  hasCapability(capability: LLMCapability): boolean {
    return this.capabilityResolver.hasCapability(capability);
  }

  /**
   * Get available capabilities.
   */
  getCapabilities(): LLMCapability[] {
    return this.capabilityResolver.getCapabilities();
  }

  /** Check one model in the effective tier against all requested capabilities. */
  supportsCapabilities(options?: UseLLMOptions): boolean {
    const requiredCapabilities = options?.capabilities ?? [];
    if (requiredCapabilities.length === 0) {
      return true;
    }

    if (!this.config.tierMapping) {
      return requiredCapabilities.every((capability) =>
        this.config.capabilities?.includes(capability)
      );
    }

    const requestedTier = options?.tier ?? this.getConfiguredTier();
    const tier = (this.config.tierMapping[requestedTier]?.length ?? 0) > 0
      ? requestedTier
      : this.getConfiguredTier();
    return (this.config.tierMapping[tier] ?? []).some((entry) =>
      requiredCapabilities.every((capability) => entry.capabilities?.includes(capability))
    );
  }

  /**
   * Resolve tier and return an immutable adapter binding.
   * Does NOT mutate router state — safe for concurrent useLLM() calls.
   */
  async resolveAdapter(options?: UseLLMOptions): Promise<LLMAdapterBinding> {
    const requestedTier = options?.tier;
    const defaultTier = this.getConfiguredTier();

    // Determine actualTier without mutating this.*
    let actualTier: LLMTier;
    if (this.config.tierMapping) {
      const tierToUse = requestedTier ?? defaultTier;
      const hasModels = (this.config.tierMapping[tierToUse]?.length ?? 0) > 0;
      if (hasModels) {
        actualTier = tierToUse;
      } else {
        actualTier = defaultTier;
        if (requestedTier && requestedTier !== defaultTier && this.logger) {
          this.logger.warn(
            `resolveAdapter: requested '${requestedTier}' tier has no models. Using '${actualTier}'.`
          );
        }
      }
    } else {
      const tierResult = this.tierResolver.resolve(requestedTier);
      actualTier = tierResult.tier;
      if (tierResult.warning && this.logger) {
        this.logger.warn(tierResult.warning);
      }
    }

    this.assertCapabilitiesSupported(actualTier, options?.capabilities);
    const entry = this.getEntryForTier(actualTier, options?.capabilities);
    const model = entry?.model ?? this.currentModel ?? 'default';
    const adapterPackage = entry?.adapter;

    const adapter = await this.getAdapter(adapterPackage);

    this.logger?.debug(`resolveAdapter: tier=${actualTier}, model=${model}`);

    return { adapter, model, tier: actualTier };
  }

  /**
   * Get current selected model.
   */
  getCurrentModel(): string | undefined {
    return this.currentModel;
  }

  /**
   * Get current adapter package (or undefined for default).
   */
  getCurrentAdapterPackage(): string | undefined {
    return this.currentAdapterPackage;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ILLM implementation (delegate to current adapter with model override)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Merge options with current model and routing metadata.
   * Metadata is used by AnalyticsLLM to track tier/provider/resource.
   */
  private withModelAndMetadata(options?: LLMOptions): LLMOptions {
    const metadata: LLMRequestMetadata = {
      tier: this.currentTier,
      provider: this.currentProvider,
      resource: this.currentResource,
    };

    const routedOptions = {
      ...options,
      model: options?.model ?? this.currentModel,
      metadata: {
        ...metadata,
        ...options?.metadata, // Allow override if needed
      },
    };
    if (options?.signal) {
      Object.defineProperty(routedOptions, 'signal', {
        value: options.signal,
        enumerable: false,
      });
    }
    return routedOptions;
  }

  /**
   * Generate a completion.
   */
  async complete(prompt: string, options?: LLMOptions): Promise<LLMResponse> {
    const adapter = await this.ensureAdapter();
    return adapter.complete(prompt, this.withModelAndMetadata(options));
  }

  /**
   * Stream a completion.
   */
  async *stream(prompt: string, options?: LLMOptions): AsyncIterable<string> {
    const adapter = await this.ensureAdapter();
    yield* adapter.stream(prompt, this.withModelAndMetadata(options));
  }

  /**
   * Return protocol capabilities of the currently resolved adapter.
   */
  async getProtocolCapabilities(): Promise<LLMProtocolCapabilities> {
    const adapter = await this.ensureAdapter();
    if (!adapter.getProtocolCapabilities) {
      return {
        cache: { supported: false },
        stream: { supported: true },
      };
    }
    return adapter.getProtocolCapabilities();
  }

  /**
   * Chat with native tool calling support.
   */
  async chatWithTools(
    messages: LLMMessage[],
    options: LLMToolCallOptions
  ): Promise<LLMToolCallResponse> {
    const adapter = await this.ensureAdapter();
    if (!adapter.chatWithTools) {
      throw new Error('Current adapter does not support chatWithTools');
    }
    return adapter.chatWithTools(messages, this.withModelAndMetadata(options) as LLMToolCallOptions);
  }

  /**
   * Check if chatWithTools is supported by current adapter.
   */
  get supportsChatWithTools(): boolean {
    return typeof this.currentAdapter.chatWithTools === 'function';
  }
}
