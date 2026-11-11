/**
 * @module @kb-labs/core-runtime/config
 * Platform configuration types.
 */

import type {
  TenantQuotas,
  LLMTier,
  LLMCapability,
  LLMExecutionPolicy,
  PIIRedactionConfig,
} from "@kb-labs/core-platform";
import type { AdapterSlot } from "@kb-labs/core-platform";
import type { ResolvedExecutionMode } from "@kb-labs/core-contracts";
import type { DeploymentTopology } from "./config-schemas.js";
import type {
  RateLimitConfig,
  RateLimitPreset,
} from "@kb-labs/core-resource-broker";

/**
 * Model entry in tier mapping.
 * Can optionally specify a different adapter per model.
 */
export interface TierModelEntry {
  /** Model identifier */
  model: string;
  /** Priority (lower = higher priority) */
  priority: number;
  /** Model capabilities */
  capabilities?: LLMCapability[];
  /** Optional: adapter package to use for this model (e.g., "@kb-labs/adapters-openai") */
  adapter?: string;
}

/**
 * Tier mapping configuration.
 */
export interface TierMapping {
  small?: TierModelEntry[];
  medium?: TierModelEntry[];
  large?: TierModelEntry[];
}

/**
 * LLM adapter options with tier support.
 */
export interface LLMAdapterOptions {
  /** Default tier when none specified @default 'medium' */
  defaultTier?: LLMTier;
  /** Tier to model mapping (advanced config) */
  tierMapping?: TierMapping;
  /** Legacy: Configured tier (simple config) @deprecated use defaultTier */
  tier?: LLMTier;
  /** Available capabilities (optional) */
  capabilities?: LLMCapability[];
  /** Default model for the underlying adapter (simple config) */
  defaultModel?: string;
  /**
   * Platform-managed default execution policy.
   * Applied to all LLM calls unless explicitly overridden by plugin via useLLM(...execution...).
   */
  executionDefaults?: LLMExecutionPolicy;
  /** Any other adapter-specific options */
  [key: string]: unknown;
}

/**
 * Adapter value type.
 * - string: Single adapter package path
 * - string[]: Multiple adapter packages (first = primary/default, others available via adapterLoader)
 * - null: NoOp adapter
 *
 * @example
 * ```typescript
 * // Single adapter
 * llm: "@kb-labs/adapters-openai"
 *
 * // Multiple adapters (multi-provider setup)
 * llm: ["@kb-labs/adapters-openai", "@kb-labs/adapters-vibeproxy"]
 *
 * // NoOp/disabled
 * analytics: null
 * ```
 */
export type AdapterValue = string | string[] | null;

/**
 * Platform adapter configuration.
 * Each key is the adapter name, value can be:
 * - string: Single adapter package path
 * - string[]: Multiple adapters (first = primary, rest available via routing/options)
 * - null: NoOp adapter
 */
export interface AdaptersConfig {
  /** Analytics adapter package(s) (e.g., "@kb-labs/analytics-adapter" or ["@kb-labs/analytics-file", "@kb-labs/analytics-posthog"]) */
  analytics?: AdapterValue;
  /** Vector store adapter package(s) (e.g., "@kb-labs/adapters-qdrant") */
  vectorStore?: AdapterValue;
  /** LLM adapter package(s) (e.g., "@kb-labs/adapters-openai" or ["@kb-labs/adapters-openai", "@kb-labs/adapters-vibeproxy"]) */
  llm?: AdapterValue;
  /** Embeddings adapter package(s) (e.g., "@kb-labs/adapters-openai/embeddings") */
  embeddings?: AdapterValue;
  /** Cache adapter package(s) (e.g., "@kb-labs/adapters-redis") */
  cache?: AdapterValue;
  /** Storage adapter package(s) (e.g., "@kb-labs/data-store") */
  storage?: AdapterValue;
  /** Logger adapter package(s) (e.g., "@kb-labs/adapters-pino") */
  logger?: AdapterValue;
  /** Document database adapter package(s) (e.g., "@kb-labs/adapters-sqlite"). */
  documentDatabase?: AdapterValue;
  /** Durable key-value store adapter package(s) (e.g., "@kb-labs/adapters-sqlite/kv"). */
  kvStore?: AdapterValue;
  /** Optional durable log store. Without it logs remain available only in configured ephemeral readers. */
  logPersistence?: AdapterValue;
  /** Optional in-process live log buffer. It is never a cross-process store. */
  logRingBuffer?: AdapterValue;
  /** Event bus adapter package(s) */
  eventBus?: AdapterValue;
  /** Environment provider adapter package(s) (e.g., "@kb-labs/adapters-environment-docker") */
  environment?: AdapterValue;
  /** Workspace provider adapter package(s) (e.g., "@kb-labs/adapters-workspace-localfs") */
  workspace?: AdapterValue;
  /** Snapshot provider adapter package(s) (e.g., "@kb-labs/adapters-snapshot-localfs") */
  snapshot?: AdapterValue;
  /** Notifier router adapter (e.g., "@kb-labs/notifier-router"). Config goes in adapterOptions.notifier. */
  notifier?: AdapterValue;
}

/** Platform config ownership for each plugin-visible adapter slot. */
export const ADAPTER_CONFIG_KEYS = {
  logger: { keys: ['logger'], projection: 'package' },
  analytics: { keys: ['analytics'], projection: 'package' },
  vectorStore: { keys: ['vectorStore'], projection: 'package' },
  llm: { keys: ['llm'], projection: 'package' },
  embeddings: { keys: ['embeddings'], projection: 'package' },
  cache: { keys: ['cache'], projection: 'package' },
  config: { keys: [], projection: 'package' },
  storage: { keys: ['storage'], projection: 'package' },
  eventBus: { keys: ['eventBus'], projection: 'package' },
  invoke: { keys: [], projection: 'package' },
  documentDatabase: { keys: ['documentDatabase'], projection: 'package' },
  kvStore: { keys: ['kvStore'], projection: 'package' },
  logs: { keys: ['logRingBuffer', 'logPersistence'], projection: 'composite' },
  artifacts: { keys: [], projection: 'package' },
  snapshotManager: { keys: ['snapshot'], projection: 'package' },
  notifier: { keys: ['notifier'], projection: 'package' },
  workspaceProvider: { keys: ['workspace'], projection: 'package' },
} as const satisfies Record<AdapterSlot | 'workspaceProvider', { keys: readonly (keyof AdaptersConfig)[]; projection: 'package' | 'composite' }>;

/**
 * Resource manager configuration.
 */
export interface ResourcesConfig {
  /** Default quotas for tenants without explicit quotas */
  defaultQuotas?: Partial<TenantQuotas>;
}

/**
 * Job scheduler configuration.
 */
export interface JobsConfig {
  /** Maximum concurrent jobs per tenant */
  maxConcurrent?: number;
  /** Poll interval in milliseconds for job queue */
  pollInterval?: number;
}

/**
 * Workflow engine configuration.
 */
export interface WorkflowsConfig {
  /** Maximum concurrent workflows per tenant */
  maxConcurrent?: number;
  /** Default workflow timeout in milliseconds */
  defaultTimeout?: number;
}

/**
 * Execution backend configuration.
 * Determines how plugins execute.
 */
export interface ExecutionConfig {
  /**
   * Execution mode:
   * - 'auto' (default): Auto-detect from environment (EXECUTION_MODE, KUBERNETES_SERVICE_HOST)
   * - 'in-process': Same process, no isolation (dev mode, fast iteration)
   * - 'worker-pool': Worker pool with fault isolation (production, single-node)
   * @default 'auto'
   */
  mode?: "auto" | ResolvedExecutionMode;

  /**
   * Workspace Agent routing options.
   * When enabled, requests with target.type === 'workspace-agent' are dispatched
   * to connected Workspace Agents via Gateway.
   */
  workspaceAgent?: {
    /** Enable workspace-agent routing (default: false) */
    enabled: boolean;
    /** Internal secret for Gateway endpoints */
    internalSecret: string;
    /** Fallback when no agent available: 'local' (default) or 'error' */
    fallback?: "local" | "error";
  };

  /**
   * Worker pool options (used when mode=worker-pool or auto-detected).
   */
  workerPool?: {
    /** Minimum workers to keep alive @default 2 */
    min?: number;
    /** Maximum concurrent workers @default 10 */
    max?: number;
    /** Max requests per worker before recycling @default 1000 */
    maxRequestsPerWorker?: number;
    /** Max worker uptime before recycling (ms) @default 1800000 (30min) */
    maxUptimeMsPerWorker?: number;
    /** Max concurrent requests per plugin (optional) */
    maxConcurrentPerPlugin?: number;
    /** Warmup policy */
    warmup?: {
      /**
       * Warmup mode (matches plugin-execution types):
       * - 'none': No warmup (cold start on first request)
       * - 'top-n': Warmup top N most-used handlers
       * - 'marked': Warmup handlers marked with warmup: true in manifest
       * @default 'none'
       */
      mode?: "none" | "top-n" | "marked";
      /** Warmup top N most used handlers (for top-n mode) @default 5 */
      topN?: number;
      /** Max handlers to warmup (safety limit) @default 20 */
      maxHandlers?: number;
    };
  };
}

/**
 * Resource broker configuration for rate limiting and queue management.
 */
export interface ResourceBrokerConfig {
  /**
   * Use distributed backend via StateBroker.
   * false = InMemoryRateLimitBackend (single process)
   * true = StateBrokerRateLimitBackend (distributed, requires StateBroker daemon)
   * @default false
   */
  distributed?: boolean;

  /**
   * LLM resource configuration.
   */
  llm?: {
    /** Rate limits (preset name or custom config) */
    rateLimits?: RateLimitConfig | RateLimitPreset;
    /** Maximum retry attempts */
    maxRetries?: number;
    /** Request timeout in ms */
    timeout?: number;
  };

  /**
   * Embeddings resource configuration.
   */
  embeddings?: {
    /** Rate limits (preset name or custom config) */
    rateLimits?: RateLimitConfig | RateLimitPreset;
    /** Maximum retry attempts */
    maxRetries?: number;
    /** Request timeout in ms */
    timeout?: number;
  };

  /**
   * Vector store resource configuration.
   */
  vectorStore?: {
    /** Maximum concurrent requests */
    maxConcurrent?: number;
    /** Maximum retry attempts */
    maxRetries?: number;
    /** Request timeout in ms */
    timeout?: number;
  };
}

/**
 * Core features configuration.
 */
export interface CoreFeaturesConfig {
  /** Resource manager configuration */
  resources?: ResourcesConfig;
  /** Job scheduler configuration */
  jobs?: JobsConfig;
  /** Workflow engine configuration */
  workflows?: WorkflowsConfig;
  /** Resource broker configuration */
  resourceBroker?: ResourceBrokerConfig;
  /**
   * Privacy / PII redaction configuration.
   * When enabled, PII is stripped from LLM inputs and restored in outputs.
   * @default { enabled: true, mode: 'reversible' }
   */
  privacy?: PIIRedactionConfig;
}

/**
 * Platform-root hint. When set in a project config, `loadPlatformConfig` uses
 * this path as `platformRoot` (expanding `~` and resolving relative paths
 * against the project root).
 */
export interface PlatformDirConfig {
  /** Absolute or `~`-relative path to the platform workspace. */
  dir?: string;
  /** Explicitly enables development workspace package resolution. */
  mode?: "development" | "production";
}

/**
 * Full platform configuration.
 */

/**
 * Generic channel config shape. Specific fields (botToken, chatId, etc.) are
 * validated by the channel adapter package — core-runtime stays unaware of them.
 */
export interface NotifierChannelConfig {
  /** Channel type identifier — matched to a channel adapter package by the loader. */
  type: string;
  [key: string]: unknown;
}

/** A single routing rule: match criteria → target channel IDs. Rules evaluated top-down (first match wins). */
export interface NotifierRoutingRule {
  match: {
    severity?: Array<"info" | "warn" | "critical">;
    /** Match by source plugin ID. */
    source?: string;
    /** Match by notification code (e.g. 'workflow.failed'). */
    code?: string;
  };
  channels: string[];
}

/**
 * Notifier adapter options — passed via adapterOptions.notifier in kb.config.json.
 * Analogous to LLMAdapterOptions for adapterOptions.llm.
 */
export interface NotifierAdapterOptions {
  /**
   * Named channel instances. Key = channel ID referenced in routing rules.
   * @example { "telegram-ops": { type: "telegram", botToken: "...", chatId: "..." } }
   */
  channels: Record<string, NotifierChannelConfig>;
  /**
   * Routing rules (top-down, first match wins).
   * @example [{ match: { severity: ["critical"] }, channels: ["telegram-ops"] }]
   */
  routing: NotifierRoutingRule[];
}

export interface PlatformConfig {
  /** Platform-root hint (only honored when set in project config). */
  platform?: PlatformDirConfig;
  /** Adapter packages configuration */
  adapters?: AdaptersConfig;
  /** Optional adapter-specific configuration passed to createAdapter(config) */
  adapterOptions?: Partial<Record<keyof AdaptersConfig, unknown>>;
  /** Core features configuration */
  core?: CoreFeaturesConfig;
  /** Execution backend configuration (NEW: unified plugin execution) */
  execution?: ExecutionConfig;
  deployment?: { topology: DeploymentTopology };
}

/**
 * Scope policy for each top-level platform-config field. Drives the
 * platform ← project merge performed by `loadPlatformConfig`.
 *
 * - `platform-only`  — project layer is ignored with a warning.
 * - `mergeable`      — project overrides platform via deep merge.
 * - `project-only`   — only the project layer is honored.
 */
export type ConfigFieldScope = "platform-only" | "mergeable" | "project-only";

export const CONFIG_FIELD_SCOPE: Record<
  keyof PlatformConfig,
  ConfigFieldScope
> = {
  platform: "project-only",
  adapters: "platform-only",
  adapterOptions: "platform-only",
  core: "platform-only",
  execution: "platform-only",
  deployment: "platform-only",
};
