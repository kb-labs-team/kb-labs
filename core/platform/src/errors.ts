/**
 * @module @kb-labs/core-platform/errors
 *
 * Platform-level error types shared by all adapter implementations.
 */

/**
 * Thrown by NoOp adapter implementations when a plugin tries to use a
 * platform service that has no honest fallback available (e.g. LLM,
 * Embeddings) and the operator hasn't configured a real adapter.
 *
 * Distinct from generic `Error` so callers can branch on it:
 *
 * ```ts
 * try {
 *   await platform.llm.complete(...);
 * } catch (err) {
 *   if (err instanceof AdapterUnavailableError) {
 *     // surface to user: "configure an LLM adapter"
 *   }
 * }
 * ```
 *
 * The gateway HTTP error mapper converts this into a structured response
 * `{code: 'ADAPTER_UNAVAILABLE', slot, reason}` for REST consumers.
 */
export class AdapterUnavailableError extends Error {
  /** Adapter slot, e.g. 'llm', 'embeddings', 'notifier'. */
  public readonly slot: string;
  /** Why the adapter is unavailable. */
  public readonly reason: 'not-configured' | 'load-failed';

  constructor(
    slot: string,
    reason: 'not-configured' | 'load-failed' = 'not-configured',
    message?: string,
  ) {
    super(
      message ??
        `Adapter "${slot}" is not available (reason: ${reason}). ` +
          `Configure a real adapter in kb.config.json under \`adapters.${slot}\`.`,
    );
    this.name = 'AdapterUnavailableError';
    this.slot = slot;
    this.reason = reason;
    Object.setPrototypeOf(this, AdapterUnavailableError.prototype);
  }
}

/**
 * Thrown when an LLM request requires capabilities that no configured model
 * in the resolved tier declares. Requested capabilities are conjunctive: the
 * selected model must declare every requested capability.
 */
export class LLMCapabilityNotSupportedError extends Error {
  public readonly code = 'LLM_CAPABILITY_NOT_SUPPORTED';

  constructor(
    public readonly tier: string,
    public readonly requiredCapabilities: string[],
    public readonly candidates: Array<{ model: string; capabilities: string[] }>,
  ) {
    const candidateSummary = candidates.length === 0
      ? 'no models are configured'
      : `configured models: ${candidates.map(({ model, capabilities }) => `${model} [${capabilities.join(', ') || 'text only'}]`).join('; ')}`;
    super(
      `LLM_CAPABILITY_NOT_SUPPORTED: tier "${tier}" cannot satisfy all required capabilities ` +
        `[${requiredCapabilities.join(', ')}]; ${candidateSummary}. Configure a model declaring every required capability or request a compatible tier.`,
    );
    this.name = 'LLMCapabilityNotSupportedError';
    Object.setPrototypeOf(this, LLMCapabilityNotSupportedError.prototype);
  }
}
