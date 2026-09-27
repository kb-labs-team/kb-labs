/**
 * @module @kb-labs/core-platform/adapters/llm-types
 * LLM tier and capability types for adaptive model routing.
 *
 * These types define the abstract layer between plugins and LLM providers.
 * Plugins request tiers/capabilities, platform resolves to actual models.
 *
 * @example
 * ```typescript
 * import { LLMTier, LLMCapability, UseLLMOptions } from '@kb-labs/sdk';
 *
 * // Plugin requests by tier (user decides what model)
 * const llm = useLLM({ tier: 'small' });
 * const llm = useLLM({ tier: 'large', capabilities: ['reasoning'] });
 * ```
 */

import type { ILLM, LLMExecutionPolicy } from './llm.js';
import { z } from 'zod';

/**
 * Model quality tier - user-defined slots.
 *
 * Tiers are NOT tied to specific models. They are abstract slots
 * that the user fills with whatever models they want in config.
 *
 * Plugin intent:
 * - `small`  - "This task is simple, doesn't need much"
 * - `medium` - "Standard task"
 * - `large`  - "Complex task, need maximum quality"
 *
 * User decides what model maps to each tier in their config.
 */
export type LLMTier = "small" | "medium" | "large";

/** Canonical tier model metadata shared with subprocess LLM proxies. */
export interface LLMModelEntry {
  model: string;
  priority: number;
  capabilities?: LLMCapability[];
  provider?: string;
  adapter?: string;
}

export type LLMTierMapping = Partial<Record<LLMTier, LLMModelEntry[]>>;

/** Non-secret router configuration required for capability preflight in workers. */
export interface LLMRouterMetadata {
  defaultTier?: LLMTier;
  tierMapping?: LLMTierMapping;
  capabilities?: LLMCapability[];
}

/** Categories used to describe a model capability in the platform catalog. */
export type LLMCapabilityCategory = "task" | "latency" | "input" | "output";

/** Human-readable definition of one platform-owned LLM capability. */
export interface LLMCapabilityDefinition {
  readonly category: LLMCapabilityCategory;
  readonly description: string;
}

const base64DataSchema = z.string().min(1).regex(
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
  'Expected base64-encoded content',
);

const textContentPartSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
}).strict();

const imageContentPartSchema = z.object({
  type: z.literal('image'),
  mediaType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/gif']),
  data: base64DataSchema,
}).strict();

/**
 * The canonical LLM contract registry. Capability definitions and supported
 * content part schemas live together here; types, runtime validation, and
 * inferred routing requirements are derived from this registry.
 *
 * Text is the implicit baseline. The first multimodal transport part is image;
 * consumers may turn PDFs into extracted text or rasterized image parts.
 */
export const LLM_CONTRACT = Object.freeze({
  capabilities: Object.freeze({
    reasoning: {
      category: 'task',
      description: 'Advanced multi-step reasoning and analysis.',
    },
    code: {
      category: 'task',
      description: 'Code generation, editing, and review.',
    },
    fast: {
      category: 'latency',
      description: 'Low-latency responses for time-sensitive tasks.',
    },
    vision: {
      category: 'input',
      description: 'Understanding image input.',
    },
    'document.input': {
      category: 'input',
      description: 'Native document input, when the provider accepts documents directly.',
    },
    'audio.input': {
      category: 'input',
      description: 'Understanding audio input.',
    },
    'audio.transcription': {
      category: 'input',
      description: 'Transcribing speech from audio into text.',
    },
    'audio.output': {
      category: 'output',
      description: 'Generating audio output.',
    },
    'video.input': {
      category: 'input',
      description: 'Understanding video input.',
    },
  } as const satisfies Record<string, LLMCapabilityDefinition>),
  contentParts: Object.freeze({
    text: Object.freeze({
      schema: textContentPartSchema,
      requiredCapabilities: [] as const,
      allowedRoles: ['user'] as const,
    }),
    image: Object.freeze({
      schema: imageContentPartSchema,
      requiredCapabilities: ['vision'] as const,
      allowedRoles: ['user'] as const,
    }),
  }),
});

/**
 * Platform-owned vocabulary for model capabilities.
 *
 * These IDs describe model capabilities, not uploaded-file types. Consumers
 * prepare their content and request the capabilities needed by the resulting
 * LLM input. For example, a PDF converted to text needs no document capability;
 * rasterized PDF pages require `vision`.
 */
export const LLM_CAPABILITIES = LLM_CONTRACT.capabilities;

/** Canonical capability IDs declared by model entries and requested by plugins. */
export type LLMCapability = keyof typeof LLM_CAPABILITIES;

type LLMContentPartSchema = (typeof LLM_CONTRACT.contentParts)[keyof typeof LLM_CONTRACT.contentParts]['schema'];

/** Type-safe ordered content blocks supported by the current LLM contract. */
export type LLMContentPart = z.infer<LLMContentPartSchema>;

/** String shorthand for text, or ordered typed multimodal parts. */
export type LLMContent = string | LLMContentPart[];

/** Render the text projection of message content without exposing binary payloads. */
export function getLLMContentText(content: LLMContent): string {
  if (typeof content === 'string') {
    return content;
  }
  return content.map((part) => part.type === 'text' ? part.text : '[image input]').join('\n');
}

export class LLMContentValidationError extends Error {
  public readonly code = 'LLM_CONTENT_INVALID';

  constructor(message: string) {
    super(`LLM_CONTENT_INVALID: ${message}`);
    this.name = 'LLMContentValidationError';
    Object.setPrototypeOf(this, LLMContentValidationError.prototype);
  }
}

/** Validate message content and derive its required input capabilities. */
export function validateLLMContent(
  role: 'system' | 'user' | 'assistant' | 'tool',
  content: unknown,
): { content: LLMContent; requiredCapabilities: LLMCapability[] } {
  if (typeof content === 'string') {
    return { content, requiredCapabilities: [] };
  }
  if (!Array.isArray(content) || content.length === 0) {
    throw new LLMContentValidationError('content must be a string or a non-empty array of content parts');
  }

  const parsedParts: LLMContentPart[] = [];
  const requiredCapabilities = new Set<LLMCapability>();

  for (const [index, value] of content.entries()) {
    let matched = false;
    for (const partDefinition of Object.values(LLM_CONTRACT.contentParts)) {
      const parsed = partDefinition.schema.safeParse(value);
      if (!parsed.success) {
        continue;
      }
      if (!partDefinition.allowedRoles.some((allowedRole) => allowedRole === role)) {
        throw new LLMContentValidationError(`content part at index ${index} is not allowed for role "${role}"`);
      }
      parsedParts.push(parsed.data);
      partDefinition.requiredCapabilities.forEach((capability) => requiredCapabilities.add(capability));
      matched = true;
      break;
    }
    if (!matched) {
      throw new LLMContentValidationError(`content part at index ${index} does not match any registered content schema`);
    }
  }

  return { content: parsedParts, requiredCapabilities: [...requiredCapabilities] };
}

/**
 * Options for useLLM() - plugin-facing API.
 *
 * Plugins specify what they need abstractly.
 * Platform resolves to actual provider/model based on user config.
 */
export interface UseLLMOptions {
  /**
   * Quality tier (user-defined slot).
   * Platform adapts if exact tier unavailable:
   * - Escalates up (small → medium) silently
   * - Degrades down (large → medium) with warning
   */
  tier?: LLMTier;

  /**
   * Additional capabilities required by this consumer's task. Input
   * capabilities are also derived automatically from validated content parts.
   */
  capabilities?: LLMCapability[];

  /**
   * Optional execution policy applied to this bound LLM instance.
   * Can be overridden per-call via LLMOptions.execution.
   */
  execution?: LLMExecutionPolicy;
}

/**
 * Resolution result from tier/capability matching.
 * Internal type used by LLMRouter.
 */
export interface LLMResolution {
  /** Resolved provider ID (e.g., 'openai', 'anthropic') */
  provider: string;
  /** Resolved model name */
  model: string;
  /** Resource name for ResourceBroker (e.g., 'llm:openai') */
  resource: string;
  /** Original requested tier */
  requestedTier: LLMTier | undefined;
  /** Actual tier being used */
  actualTier: LLMTier;
  /** Whether this was escalated/degraded */
  adapted: boolean;
  /** Warning message if degraded */
  warning?: string;
}

/**
 * Resolved adapter binding — immutable snapshot of a tier resolution.
 * Returned by resolveAdapter() to avoid global state mutation.
 */
export interface LLMAdapterBinding {
  /** The concrete adapter instance (already wrapped with analytics, etc.) */
  adapter: ILLM;
  /** Resolved model name */
  model: string;
  /** Actual tier used */
  tier: LLMTier;
}

/**
 * LLM Router interface - extends ILLM with routing capabilities.
 * Implemented by @kb-labs/llm-router.
 */
export interface ILLMRouter {
  /** Get configured tier (what user set in config) */
  getConfiguredTier(): LLMTier;

  /** Resolve tier request to actual model (mutates router state — legacy) */
  resolve(options?: UseLLMOptions): LLMResolution;

  /**
   * Resolve tier and return an immutable adapter binding.
   * Does NOT mutate router state — safe for concurrent useLLM() calls.
   */
  resolveAdapter(options?: UseLLMOptions): Promise<LLMAdapterBinding>;

  /** Check if capability is available */
  hasCapability(capability: LLMCapability): boolean;

  /** Get available capabilities */
  getCapabilities(): LLMCapability[];

  /** Check whether one model in the resolved tier declares every requirement. */
  supportsCapabilities(options?: UseLLMOptions): boolean;
}

/**
 * Tier order for resolution (lowest to highest).
 */
export const TIER_ORDER: readonly LLMTier[] = [
  "small",
  "medium",
  "large",
] as const;

/**
 * Check if tier A is higher than tier B.
 */
export function isTierHigher(a: LLMTier, b: LLMTier): boolean {
  return TIER_ORDER.indexOf(a) > TIER_ORDER.indexOf(b);
}

/**
 * Check if tier A is lower than tier B.
 */
export function isTierLower(a: LLMTier, b: LLMTier): boolean {
  return TIER_ORDER.indexOf(a) < TIER_ORDER.indexOf(b);
}
