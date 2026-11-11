/**
 * @module @kb-labs/core-platform/adapters/adapter-manifest
 * Adapter manifest schema for dependency management and extension points.
 */

/**
 * Adapter type classification.
 *
 * - core: Primary adapter implementing a platform interface (e.g., logger, db)
 * - extension: Adapter that extends another adapter via hooks (e.g., log persistence)
 * - proxy: Adapter that wraps/delegates to another adapter (e.g., IPC proxy)
 */
export type AdapterType = "core" | "extension" | "proxy";

/**
 * Adapter dependency specification.
 *
 * Short form: runtime adapter token (config key in `platform.adapters`)
 * Long form: { id, alias } where alias is used in factory deps parameter
 */
export type AdapterDependency = string | { id: string; alias?: string };

/**
 * Extension point configuration.
 *
 * Describes how this adapter extends another adapter:
 * - adapter: Target adapter ID (e.g., "logger")
 * - hook: Method name on target adapter (e.g., "onLog")
 * - method: Method name on this adapter to call (e.g., "write")
 * - priority: Call order (higher = called first, default: 0)
 */
export interface AdapterExtension {
  /** Target adapter ID to extend */
  adapter: string;

  /** Hook method on target adapter (e.g., "onLog") */
  hook: string;

  /** Method on this adapter to call when hook fires (e.g., "write") */
  method: string;

  /**
   * Priority for extension ordering.
   * Higher values are called first.
   * Default: 0
   * Ties resolved by registration order.
   */
  priority?: number;
}

/**
 * Adapter capabilities declaration.
 *
 * Describes what features this adapter supports.
 * Used for adapter selection and runtime feature detection.
 */
export interface AdapterCapabilities {
  /** Supports streaming/realtime data */
  streaming?: boolean;

  /** Supports batch operations */
  batch?: boolean;

  /** Supports search/query operations */
  search?: boolean;

  /** Supports transactions */
  transactions?: boolean;

  /** Custom capabilities (adapter-specific) */
  custom?: Record<string, unknown>;
}

/**
 * Adapter manifest.
 *
 * Every adapter exports a manifest describing its:
 * - Identity (id, name, version)
 * - Type (core/extension/proxy)
 * - Interface implementation (implements: "ILogger")
 * - Dependencies (requires, optional)
 * - Extension points (extends: { adapter, hook, method })
 * - Capabilities (streaming, batch, search, etc.)
 *
 * @example Core adapter (Pino logger)
 * ```typescript
 * export const manifest: AdapterManifest = {
 *   schema: 'kb.adapter/1',
 *   manifestVersion: '1.0.0',
 *   id: 'pino-logger',
 *   name: 'Pino Logger',
 *   version: '1.0.0',
 *   type: 'core',
 *   implements: 'ILogger',
 *   optional: { adapters: ['analytics'] },
 *   capabilities: { streaming: true }
 * };
 * ```
 *
 * @example Extension adapter (Ring buffer)
 * ```typescript
 * export const manifest: AdapterManifest = {
 *   schema: 'kb.adapter/1',
 *   manifestVersion: '1.0.0',
 *   id: 'log-ringbuffer',
 *   name: 'Log Ring Buffer',
 *   version: '1.0.0',
 *   type: 'extension',
 *   implements: 'ILogRingBuffer',
 *   extends: {
 *     adapter: 'logger',
 *     hook: 'onLog',
 *     method: 'append',
 *     priority: 10
 *   },
 *   capabilities: { streaming: true }
 * };
 * ```
 *
 * @example Extension with dependency (SQLite persistence)
 * ```typescript
 * export const manifest: AdapterManifest = {
 *   schema: 'kb.adapter/1',
 *   manifestVersion: '1.0.0',
 *   id: 'log-persistence',
 *   name: 'SQLite Log Persistence',
 *   version: '1.0.0',
 *   type: 'extension',
 *   implements: 'ILogPersistence',
 *   requires: {
 *     adapters: [{ id: 'db', alias: 'database' }],
 *     platform: '>= 1.0.0'
 *   },
 *   extends: {
 *     adapter: 'logger',
 *     hook: 'onLog',
 *     method: 'write',
 *     priority: 5
 *   },
 *   capabilities: { batch: true, search: true, transactions: true }
 * };
 * ```
 */
export interface AdapterManifest {
  /** Declarative adapter manifest contract consumed by discovery and release preparation. */
  schema: 'kb.adapter/1';

  /**
   * Manifest schema version.
   * Used for compatibility checking and evolution.
   * Format: semver (e.g., "1.0.0")
   */
  manifestVersion: string;

  // ═══════════════════════════════════════════════════════════════════════════
  // Identity
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Unique adapter identifier.
   * Used in dependency resolution and configuration.
   * Convention: kebab-case (e.g., "pino-logger", "log-ringbuffer")
   */
  id: string;

  /**
   * Human-readable adapter name.
   * Shown in logs, UI, documentation.
   */
  name: string;

  /**
   * Adapter version.
   * Format: semver (e.g., "1.0.0")
   */
  version: string;

  /** Release compatibility constraints copied into the sealed platform index. */
  compatibility?: {
    platformRange?: string;
    sdkRange?: string;
  };

  /**
   * Adapter description (optional).
   * Brief explanation of what this adapter does.
   */
  description?: string;

  /**
   * Author information (optional).
   */
  author?: string;

  /**
   * License (optional).
   * SPDX identifier (e.g., "MIT", "Apache-2.0")
   */
  license?: string;

  /**
   * Homepage URL (optional).
   * Link to documentation or repository.
   */
  homepage?: string;

  // ═══════════════════════════════════════════════════════════════════════════
  // Classification
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Adapter type.
   * - core: Primary adapter implementing a platform interface
   * - extension: Extends another adapter via hooks
   * - proxy: Wraps/delegates to another adapter
   */
  type: AdapterType;

  /**
   * Contracts this adapter implements.
   *
   * Single contract: `implements: 'ILogger'`.
   * Multi-role driver: `implements: ['IDocumentDatabase', 'IKVStore']` —
   * one package fills several platform slots (e.g. sqlite ships both a
   * document store and a KV store on a shared connection).
   *
   * Convention: PascalCase interface name. Informational only — TypeScript
   * provides compile-time type safety, no runtime type checking is performed.
   */
  implements: string | string[];

  /** Whether using this adapter requires reaching a network service. */
  networkRequired: boolean;

  /** Configuration value used to select this adapter when it implements a typed extension point. */
  channelType?: string;

  /** Default platform slots mapped to package entry-point path segments. Empty segments select the package root. */
  defaultFor?: Record<string, string[]>;

  // ═══════════════════════════════════════════════════════════════════════════
  // Dependencies
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Required dependencies.
   *
   * If any required dependency is missing, adapter load fails immediately.
   *
   * @example
   * ```typescript
   * requires: {
   *   adapters: ['db'],                          // Runtime token from config
   *   adapters: [{ id: 'db', alias: 'database' }], // Runtime token + factory alias
   *   platform: '>= 1.0.0'                       // Semver range
   * }
   * ```
   */
  requires?: {
    /**
     * Required adapters by runtime token (config key), NOT by `manifest.id`.
     *
     * Example:
     * - `platform.adapters.cache = "@kb-labs/adapters-redis"`
     * - runtime token is `cache`
     * - provider manifest id can be `redis-cache`
     * - dependency must reference `cache`, not `redis-cache`
     *
     * Each will be passed to factory function in `deps` parameter.
     */
    adapters?: AdapterDependency[];

    /** Named platform services injected into the factory dependency object. */
    platformServices?: Array<
      | 'resourceBroker'
      | 'notifierChannels'
      | { id: 'resourceBroker' | 'notifierChannels'; alias?: string }
    >;

    /**
     * Required platform version (semver range).
     * Example: ">= 1.0.0", "^1.2.0", "~1.2.3"
     */
    platform?: string;
  };

  /**
   * Optional dependencies.
   *
   * If optional dependency is missing, adapter still loads (no error).
   * Factory function receives `undefined` for missing optional deps.
   *
   * @example
   * ```typescript
   * optional: {
   *   adapters: ['analytics', 'metrics']
   * }
   * ```
   */
  optional?: {
    /** Optional adapters (by ID) */
    adapters?: string[];
  };

  /**
   * Requested runtime contexts.
   *
   * Specifies which runtime contexts this adapter needs.
   * Requested contexts are injected into the adapter's config by the loader.
   *
   * Available contexts:
   * - 'workspace': { cwd: string } - Workspace directory path
   * - 'analytics': AnalyticsContext - Analytics enrichment context (source, actor, runId)
   * - 'tenant': TenantContext - Multi-tenancy context (future)
   * - 'request': RequestContext - HTTP request context (future)
   *
   * @example
   * ```typescript
   * contexts: ['workspace', 'analytics']
   * ```
   */
  contexts?: string[];

  // ═══════════════════════════════════════════════════════════════════════════
  // Extension Point
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Extension point configuration.
   *
   * If present, this adapter extends another adapter via a hook.
   * The platform automatically connects the extension after all adapters load.
   *
   * @example
   * ```typescript
   * extends: {
   *   adapter: 'logger',     // Target adapter
   *   hook: 'onLog',         // Hook method on target
   *   method: 'write',       // Method on this adapter
   *   priority: 5            // Call order (optional)
   * }
   * ```
   */
  extends?: AdapterExtension;

  // ═══════════════════════════════════════════════════════════════════════════
  // Capabilities
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Adapter capabilities.
   *
   * Describes what features this adapter supports.
   * Used for adapter selection and runtime feature detection.
   *
   * @example
   * ```typescript
   * capabilities: {
   *   streaming: true,
   *   batch: true,
   *   search: true,
   *   transactions: true,
   *   custom: { maxBatchSize: 1000 }
   * }
   * ```
   */
  capabilities?: AdapterCapabilities;

  /**
   * Middleware declarations for the platform adapter pipeline.
   *
   * Each entry inserts a wrap function into a named slot in the pipeline.
   * The runtime loads, validates, and applies these in slot order + local priority.
   *
   * @example
   * ```typescript
   * middlewares: [
   *   {
   *     id: 'cost-tracker',
   *     handler: './middlewares/cost-tracker.js',
   *     slot: 'post-resource-broker',
   *     target: 'llm',
   *     priority: 10,
   *   }
   * ]
   * ```
   */
  middlewares?: AdapterMiddlewareDecl[];

  // ═══════════════════════════════════════════════════════════════════════════
  // Configuration Schema (Optional)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Configuration options schema (optional).
   *
   * Declares what configuration options this adapter accepts.
   * Useful for:
   * - Auto-generating documentation
   * - IDE auto-completion
   * - Configuration validation tools
   * - UI configuration builders
   *
   * This is informational only - TypeScript provides compile-time validation.
   *
   * @example
   * ```typescript
   * configSchema: {
   *   level: {
   *     type: 'string',
   *     enum: ['trace', 'debug', 'info', 'warn', 'error'],
   *     default: 'info',
   *     description: 'Minimum log level'
   *   },
   *   pretty: {
   *     type: 'boolean',
   *     default: false,
   *     description: 'Enable pretty printing'
   *   },
   *   batchSize: {
   *     type: 'number',
   *     default: 100,
   *     description: 'Number of logs per batch'
   *   }
   * }
   * ```
   */
  configSchema?: Record<
    string,
    {
      type: "string" | "number" | "boolean" | "object" | "array";
      description?: string;
      default?: unknown;
      required?: boolean;
      /** The option is secret material and may be absent during adapter construction. */
      secret?: boolean;
      /** Environment variable that supplies this secret option. */
      env?: string;
      enum?: unknown[];
      /** Require an integral numeric value. */
      integer?: boolean;
      /** Inclusive lower bound for a numeric option. */
      minimum?: number;
      /** User-facing explanation when the lower bound is violated. */
      minimumMessage?: string;
      /** Inclusive upper bound for a numeric option. */
      maximum?: number;
      /** Copy-ready correction for an invalid value. */
      hint?: string;
      /** Resolve a relative filesystem option against a runtime-owned root. */
      pathBase?: 'platformData';
      /** Default this path beneath the registered project's durable state directory. */
      defaultPath?: { root: 'projectState'; segments: string[] };
      /** Values such as `:memory:` that are path options but not files. */
      specialValues?: string[];
      properties?: Record<string, unknown>;
      /** Additional doctor metadata for this option; required/secret/env come from this schema field. */
      doctor?: Array<{
        /** Default adapter slot that owns this doctor requirement. */
        slot: string;
        id: string;
        optional?: boolean;
        severity?: 'error' | 'warning';
        services: string[];
        action?: string;
        hint: string;
      }>;
    }
  >;
}

const ADAPTER_SLOT_CONTRACTS: Record<string, string> = {
  logger: 'ILogger',
  cache: 'ICache',
  storage: 'IStorage',
  eventBus: 'IEventBus',
  documentDatabase: 'IDocumentDatabase',
  kvStore: 'IKVStore',
  analytics: 'IAnalytics',
  llm: 'ILLM',
  embeddings: 'IEmbeddings',
  vectorStore: 'IVectorStore',
  logs: 'ILogReader',
  snapshotManager: 'ISnapshotManager',
};

/** Whether a manifest declares the platform slot through its identity fields. */
export function adapterManifestProvidesSlot(manifest: AdapterManifest, slot: string): boolean {
  if (manifest.defaultFor && Object.hasOwn(manifest.defaultFor, slot)) {return true;}
  const contract = ADAPTER_SLOT_CONTRACTS[slot];
  if (!contract) {return false;}
  const roles = Array.isArray(manifest.implements) ? manifest.implements : [manifest.implements];
  return roles.includes(contract);
}

// ═══════════════════════════════════════════════════════════════════════════
// Middleware declarations (pipeline extension points)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Declares a single adapter-provided middleware to be inserted into the platform pipeline.
 *
 * Middlewares are loaded at plugin boot time and applied in slot order, then local priority.
 * System slots ('router', 'resource-broker', 'governance') are reserved and cannot be targeted.
 */
export interface AdapterMiddlewareDecl {
  /** Unique identifier within this adapter (used in logs/errors). */
  id: string;

  /** Path to the handler file relative to the adapter package root. */
  handler: string;

  /**
   * Named pipeline slot (recommended).
   * Must not be a reserved slot. Defaults to 'post-resource-broker'.
   * Valid values: 'raw' | 'post-router' | 'post-resource-broker'
   */
  slot?: string;

  /** Insert after this named stage (fine-grained alternative to slot). */
  after?: string;

  /** Insert before this named stage (fine-grained alternative to slot). */
  before?: string;

  /**
   * Local priority within the chosen slot. Higher = runs later. Default: 0.
   * Not a global ordering number — stays meaningful even when system stages change.
   */
  priority?: number;

  /**
   * Platform adapter interface this middleware wraps.
   * Examples: 'llm', 'cache', 'vectorStore', 'embeddings'
   * Must match a key in PlatformServices.
   */
  target: string;
}

/**
 * Resolved middleware declaration as stored on the platform container.
 * Collected in loader.ts during adapter loading; resolved in execution backends.
 */
export interface RawMiddlewareDecl {
  /** Absolute path to the adapter package root. */
  pkgRoot: string;
  /** Declaration from AdapterManifest.middlewares[]. */
  decl: AdapterMiddlewareDecl;
}

/**
 * Adapter factory function signature.
 *
 * Every adapter exports a createAdapter function that:
 * - Accepts adapter-specific config
 * - Receives dependencies via deps parameter
 * - Returns adapter instance implementing the declared interface
 *
 * @template TConfig - Adapter configuration type
 * @template TDeps - Dependencies object type (from manifest.requires)
 * @template TAdapter - Adapter interface type (from manifest.implements)
 *
 * @example
 * ```typescript
 * export function createAdapter(
 *   config: PinoConfig,
 *   deps: { analytics?: IAnalytics }
 * ): ILogger {
 *   return new PinoAdapter(config, deps);
 * }
 * ```
 */
export type AdapterFactory<
  TConfig = unknown,
  TDeps = Record<string, unknown>,
  TAdapter = unknown,
> = (config: TConfig, deps: TDeps) => TAdapter | Promise<TAdapter>;
