/**
 * @module @kb-labs/core-platform/wrappers/pii-redaction-llm
 * ILLM decorator that strips PII before sending to LLM and restores in response.
 *
 * Sits in the LLM wrapper chain:
 *   LLMRouter → QueuedLLM → PIIRedactionLLM → AnalyticsLLM → RawAdapter
 *
 * Modes:
 *   - reversible (default): PII → [PII_001] placeholder, restored in response
 *   - one-way: PII → [REDACTED:email], no restoration
 *
 * Only the platform knows the mapping — LLM provider never sees real PII.
 */

import type {
  ILLM,
  LLMOptions,
  LLMResponse,
  LLMMessage,
  LLMToolCallOptions,
  LLMToolCallResponse,
  LLMProtocolCapabilities,
} from '../adapters/llm.js';
import type {
  ILLMRouter,
  LLMResolution,
  LLMAdapterBinding,
  UseLLMOptions,
  LLMCapability,
} from '../adapters/llm-types.js';
import type { IPIIDetector, PIIDetectorConfig } from './pii-detector.js';
import { RegexPIIDetector } from './pii-detector.js';

// ── Config ───────────────────────────────────────────────────────────────────

export type PIIRedactionMode = 'reversible' | 'one-way';

export interface PIIRedactionConfig {
  /** Enable/disable PII redaction @default true */
  enabled?: boolean;
  /** Masking mode @default 'reversible' */
  mode?: PIIRedactionMode;
  /** Detector configuration (patterns, allowlist, custom patterns) */
  detector?: PIIDetectorConfig;
}

// ── Wrapper ──────────────────────────────────────────────────────────────────

export class PIIRedactionLLM implements ILLM {
  private readonly detector: IPIIDetector;
  private readonly mode: PIIRedactionMode;

  constructor(
    private readonly realLLM: ILLM,
    config: PIIRedactionConfig = {},
    detector?: IPIIDetector,
  ) {
    this.mode = config.mode ?? 'reversible';
    this.detector = detector ?? new RegexPIIDetector(config.detector);
  }

  // ── ILLM interface ───────────────────────────────────────────────────────

  async getProtocolCapabilities(): Promise<LLMProtocolCapabilities> {
    if (!this.realLLM.getProtocolCapabilities) {
      return { cache: { supported: false }, stream: { supported: true } };
    }
    return this.realLLM.getProtocolCapabilities();
  }

  async complete(prompt: string, options?: LLMOptions): Promise<LLMResponse> {
    const { text: redactedPrompt, map } = this.redactText(prompt);
    const redactedOptions = this.redactOptions(options, map);

    const response = await this.realLLM.complete(redactedPrompt, redactedOptions);

    return {
      ...response,
      content: this.restoreText(response.content, map),
    };
  }

  async *stream(prompt: string, options?: LLMOptions): AsyncIterable<string> {
    const { text: redactedPrompt, map } = this.redactText(prompt);
    const redactedOptions = this.redactOptions(options, map);

    if (map.size === 0) {
      // No PII found — stream through directly
      yield* this.realLLM.stream(redactedPrompt, redactedOptions);
      return;
    }

    // Buffer chunks to handle placeholders split across chunk boundaries.
    // Strategy: accumulate buffer, find safe split point (last ']' or no open '['),
    // restore and yield the safe prefix, keep the rest.
    let buffer = '';

    for await (const chunk of this.realLLM.stream(redactedPrompt, redactedOptions)) {
      buffer += chunk;

      // Find safe split: everything up to (and including) the last ']'
      // that isn't part of an incomplete placeholder.
      const lastClose = buffer.lastIndexOf(']');
      const lastOpen = buffer.lastIndexOf('[');

      let splitAt: number;
      if (lastOpen > lastClose) {
        // Unmatched '[' — might be start of a placeholder, hold it back
        splitAt = lastOpen;
      } else if (lastClose >= 0) {
        // Complete bracket pair — safe to flush up to and including ']'
        splitAt = lastClose + 1;
      } else {
        // No brackets — everything is safe
        splitAt = buffer.length;
      }

      if (splitAt > 0) {
        const safe = buffer.slice(0, splitAt);
        const restored = this.restoreText(safe, map);
        if (restored.length > 0) {
          yield restored;
        }
        buffer = buffer.slice(splitAt);
      }
    }

    // Flush remaining buffer
    if (buffer.length > 0) {
      yield this.restoreText(buffer, map);
    }
  }

  async chatWithTools(
    messages: LLMMessage[],
    options: LLMToolCallOptions,
  ): Promise<LLMToolCallResponse> {
    if (!this.realLLM.chatWithTools) {
      throw new Error('Underlying LLM does not support chatWithTools');
    }

    // Build a shared placeholder map across all messages for consistent masking
    const sharedMap = new Map<string, string>();
    const redactedMessages = messages.map((msg) => this.redactMessage(msg, sharedMap));

    // Redact system prompt in options if present
    const redactedOptions = this.redactOptions(options, sharedMap) as LLMToolCallOptions;
    redactedOptions.tools = options.tools;
    redactedOptions.toolChoice = options.toolChoice;

    const response = await this.realLLM.chatWithTools(redactedMessages, redactedOptions);

    return this.restoreToolResponse(response, sharedMap);
  }

  // ── ILLMRouter proxy (preserves tier routing through wrapper chain) ────

  getConfiguredTier(): string {
    const router = this.realLLM as unknown as ILLMRouter;
    if (typeof router.getConfiguredTier === 'function') {
      return router.getConfiguredTier();
    }
    return 'small';
  }

  resolve(options?: UseLLMOptions): LLMResolution {
    const router = this.realLLM as unknown as ILLMRouter;
    if (typeof router.resolve === 'function') {
      return router.resolve(options);
    }
    throw new Error('Underlying LLM does not support resolve()');
  }

  async resolveAdapter(options?: UseLLMOptions): Promise<LLMAdapterBinding> {
    const router = this.realLLM as unknown as ILLMRouter;
    if (typeof router.resolveAdapter === 'function') {
      return router.resolveAdapter(options);
    }
    throw new Error('Underlying LLM does not support resolveAdapter()');
  }

  hasCapability(capability: LLMCapability): boolean {
    const router = this.realLLM as unknown as ILLMRouter;
    if (typeof router.hasCapability === 'function') {
      return router.hasCapability(capability);
    }
    return false;
  }

  getCapabilities(): LLMCapability[] {
    const router = this.realLLM as unknown as ILLMRouter;
    if (typeof router.getCapabilities === 'function') {
      return router.getCapabilities();
    }
    return [];
  }

  supportsCapabilities(options?: UseLLMOptions): boolean {
    const router = this.realLLM as unknown as ILLMRouter;
    if (typeof router.supportsCapabilities === 'function') {
      return router.supportsCapabilities(options);
    }
    return false;
  }

  // ── Private helpers ────────────────────────────────────────────────────

  private redactText(text: string): { text: string; map: Map<string, string> } {
    const prefix = this.mode === 'reversible' ? 'PII' : 'REDACTED';
    const result = this.detector.redact(text, prefix);
    return { text: result.redacted, map: result.placeholderMap };
  }

  /**
   * Redact text reusing an existing shared placeholder map.
   * New PII values get new placeholders appended to the shared map.
   */
  private redactTextShared(text: string, sharedMap: Map<string, string>): string {
    const prefix = this.mode === 'reversible' ? 'PII' : 'REDACTED';
    const result = this.detector.redact(text, prefix);

    // Merge new placeholders into shared map (offset counter)
    const existingValues = new Map<string, string>();
    for (const [placeholder, original] of sharedMap) {
      existingValues.set(original, placeholder);
    }

    let merged = result.redacted;
    for (const [placeholder, original] of result.placeholderMap) {
      const existing = existingValues.get(original);
      if (existing) {
        // Reuse existing placeholder for same value
        const escaped = placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        merged = merged.replace(new RegExp(escaped, 'g'), existing);
      } else {
        // Renumber: use sharedMap.size + 1 as next counter
        const newNum = sharedMap.size + 1;
        const newPlaceholder = `[${prefix}_${String(newNum).padStart(3, '0')}]`;
        const escaped = placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        merged = merged.replace(new RegExp(escaped, 'g'), newPlaceholder);
        sharedMap.set(newPlaceholder, original);
        existingValues.set(original, newPlaceholder);
      }
    }

    return merged;
  }

  private restoreText(text: string, map: Map<string, string>): string {
    if (this.mode === 'one-way' || map.size === 0) {
      return text;
    }
    return this.detector.restore(text, map);
  }

  private redactOptions(options: LLMOptions | undefined, map: Map<string, string>): LLMOptions | undefined {
    if (!options?.systemPrompt) {
      return options;
    }

    const redacted = this.redactTextShared(options.systemPrompt, map);
    const redactedOptions = { ...options, systemPrompt: redacted };
    if (options.signal) {
      Object.defineProperty(redactedOptions, 'signal', {
        value: options.signal,
        enumerable: false,
      });
    }
    return redactedOptions;
  }

  private redactMessage(msg: LLMMessage, sharedMap: Map<string, string>): LLMMessage {
    if (typeof msg.content === 'string') {
      const redactedContent = this.redactTextShared(msg.content, sharedMap);
      return redactedContent === msg.content ? msg : { ...msg, content: redactedContent };
    }

    let changed = false;
    const redactedContent = msg.content.map((part) => {
      if (part.type !== 'text') {
        return part;
      }
      const redactedText = this.redactTextShared(part.text, sharedMap);
      if (redactedText === part.text) {
        return part;
      }
      changed = true;
      return { ...part, text: redactedText };
    });

    return changed ? { ...msg, content: redactedContent } : msg;
  }

  private restoreToolResponse(
    response: LLMToolCallResponse,
    map: Map<string, string>,
  ): LLMToolCallResponse {
    if (this.mode === 'one-way' || map.size === 0) {
      return response;
    }

    const restored: LLMToolCallResponse = {
      ...response,
      content: this.detector.restore(response.content, map),
    };

    // Restore PII in tool call arguments (LLM might reference placeholders)
    if (restored.toolCalls) {
      restored.toolCalls = restored.toolCalls.map((tc) => {
        if (typeof tc.input === 'string') {
          return { ...tc, input: this.detector.restore(tc.input, map) };
        }
        if (tc.input && typeof tc.input === 'object') {
          const serialized = JSON.stringify(tc.input);
          const restoredJson = this.detector.restore(serialized, map);
          try {
            return { ...tc, input: JSON.parse(restoredJson) };
          } catch {
            return tc;
          }
        }
        return tc;
      });
    }

    return restored;
  }
}

/**
 * Factory: creates PIIRedactionLLM if config is enabled, otherwise returns original LLM.
 */
export function createPIIRedactionLLM(
  llm: ILLM,
  config?: PIIRedactionConfig,
): ILLM {
  if (!config || config.enabled === false) {
    return llm;
  }

  return new PIIRedactionLLM(llm, config);
}
