/**
 * @module @kb-labs/llm-router/resolver
 * Tier resolution logic with adaptive escalation/degradation.
 */

import type { LLMTier, LLMCapability } from '@kb-labs/core-platform';
import { TIER_ORDER } from '@kb-labs/core-platform';

/**
 * Resolution result.
 */
export interface ResolveResult {
  /** Actual tier to use */
  tier: LLMTier;
  /** Whether adaptation occurred */
  adapted: boolean;
  /** Warning message (only for degradation) */
  warning?: string;
}

/**
 * Tier resolver with adaptive escalation/degradation.
 *
 * Resolution rules:
 * - Exact match → use as-is
 * - Request lower than configured → escalate silently (small → medium)
 * - Request higher than configured → degrade with warning (large → medium)
 */
export class TierResolver {
  private configuredIndex: number;

  constructor(private configuredTier: LLMTier) {
    this.configuredIndex = TIER_ORDER.indexOf(configuredTier);
  }

  /**
   * Resolve requested tier to actual tier.
   *
   * @param requestedTier - Tier requested by plugin (or undefined for default)
   * @returns Resolution result with actual tier and adaptation info
   */
  resolve(requestedTier?: LLMTier): ResolveResult {
    // No request → use configured default
    if (!requestedTier) {
      return { tier: this.configuredTier, adapted: false };
    }

    const requestedIndex = TIER_ORDER.indexOf(requestedTier);

    // Exact match
    if (requestedIndex === this.configuredIndex) {
      return { tier: this.configuredTier, adapted: false };
    }

    // Escalation: requested < configured (e.g., small → medium)
    // This is fine - plugin asked for less, we give more
    if (requestedIndex < this.configuredIndex) {
      return {
        tier: this.configuredTier,
        adapted: true,
        // No warning - escalation is acceptable
      };
    }

    // Degradation: requested > configured (e.g., large → medium)
    // This needs a warning - plugin wanted more than available
    return {
      tier: this.configuredTier,
      adapted: true,
      warning: `Requested '${requestedTier}' tier but only '${this.configuredTier}' available. Using ${this.configuredTier}.`,
    };
  }

  /**
   * Get the configured tier.
   */
  getConfiguredTier(): LLMTier {
    return this.configuredTier;
  }
}

/**
 * Capability resolver.
 *
 * Text input is implicit. All optional capabilities must be explicitly
 * declared by model configuration; an empty set means no such capability is
 * known to be available.
 */
export class CapabilityResolver {
  constructor(private availableCapabilities: Set<LLMCapability> = new Set()) {}

  /**
   * Check if capability is available.
   */
  hasCapability(capability: LLMCapability): boolean {
    return this.availableCapabilities.has(capability);
  }

  /**
   * Check if all requested capabilities are available.
   */
  hasAllCapabilities(capabilities: LLMCapability[]): boolean {
    return capabilities.every((cap) => this.hasCapability(cap));
  }

  /**
   * Get available capabilities.
   */
  getCapabilities(): LLMCapability[] {
    return Array.from(this.availableCapabilities);
  }
}
