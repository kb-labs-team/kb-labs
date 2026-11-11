/**
 * Plugin Context V3 for V3 Plugin System
 *
 * The main interface that plugins receive when executed.
 * Combines all services: UI, platform, runtime, API.
 */

import type { HostContext, HostType } from './host-context.js';
import type { TraceContext } from './trace.js';
import type { PluginHandlerUIFacade, UIFacade } from './ui.js';
import type { PluginServices } from './platform.js';
import type { RuntimeAPI } from './runtime.js';
import type { PluginAPI } from './api.js';
import type { ProcessIdentity } from './process-identity.js';

/**
 * Plugin Context V3
 *
 * The full context provided to plugin handlers.
 *
 * @template TConfig Plugin configuration type
 */
export interface PluginContextV3<TConfig = unknown> {
  // ==========================================================================
  // Metadata
  // ==========================================================================

  /**
   * Entry point type (cli, rest, workflow, webhook)
   */
  readonly host: HostType;

  /**
   * Unique request ID for this execution
   */
  readonly requestId: string;

  /**
   * Plugin identifier (from manifest)
   */
  readonly pluginId: string;

  /**
   * Plugin version (from manifest)
   */
  readonly pluginVersion: string;

  /**
   * Tenant ID for multi-tenancy
   */
  readonly tenantId?: string;

  /**
   * Current working directory
   */
  readonly cwd: string;

  /**
   * Output directory for artifacts
   */
  readonly outdir?: string;

  /**
   * Plugin configuration (typed)
   */
  readonly config?: TConfig;

  // ==========================================================================
  // Cancellation
  // ==========================================================================

  /**
   * Abort signal for cancellation
   *
   * Plugins should check this and abort long-running operations.
   */
  readonly signal?: AbortSignal;

  /** Persist ownership of a spawned long-running child before its handler continues. */
  readonly onProcessStarted?: (identity: ProcessIdentity) => Promise<void>;

  // ==========================================================================
  // Tracing
  // ==========================================================================

  /**
   * Distributed tracing context
   */
  readonly trace: TraceContext;

  // ==========================================================================
  // Host-specific context
  // ==========================================================================

  /**
   * Host-specific context (discriminated union)
   *
   * Use type narrowing based on `host` field:
   *
   * ```ts
   * if (ctx.hostContext.host === 'cli') {
   *   ctx.hostContext.argv // string[]
   * }
   * ```
   */
  readonly hostContext: HostContext;

  // ==========================================================================
  // Services
  // ==========================================================================

  /**
   * UI facade for user interaction
   *
   * Output goes to stdout (CLI), response (REST), or logs (workflow).
   */
  readonly ui: UIFacade;

  /**
   * Platform services (governed)
   *
   * Access to LLM, embeddings, vector store, cache, storage, analytics.
   * In sandbox mode, these are RPC proxies to the parent process.
   */
  readonly platform: PluginServices;

  /**
   * Runtime API (sandboxed)
   *
   * Sandboxed access to filesystem, network, environment.
   */
  readonly runtime: RuntimeAPI;

  /**
   * Plugin API
   *
   * High-level APIs: invoke, state, artifacts, shell, events, output, lifecycle.
   */
  readonly api: PluginAPI;
}

/** Context contract passed specifically to CLI command handlers. */
export type PluginCommandContextV3<TConfig = unknown> = Omit<PluginContextV3<TConfig>, 'ui'> & {
  readonly ui: PluginHandlerUIFacade;
};

/**
 * Type helper to extract config type from context
 */
export type ExtractConfig<T> = T extends PluginContextV3<infer C> ? C : never;
