/**
 * @module @kb-labs/core-platform/error-envelope
 *
 * Canonical execution request contracts.
 * This module must not depend on plugin-layer contracts.
 */

/**
 * Core execution descriptor.
 *
 * Plugin/runtime specific layers may provide richer descriptor types via
 * ExecutionRequest<TDescriptor>.
 */
export interface ExecutionDescriptorCore {
  requestId?: string;
  tenantId?: string;
  pluginId?: string;
  pluginVersion?: string;
  handlerId?: string;
  [key: string]: unknown;
}

/**
 * Execution target type.
 *
 * - `platform` — execute on the platform (in-process or worker pool)
 * - `workspace-agent` — execute on a connected Workspace Agent (near the code)
 * - `environment` — execute in a specific provisioned environment (container)
 *
 * When `type` is omitted, RoutingBackend uses deployment-level routing config.
 */
export type ExecutionTargetType = 'platform' | 'workspace-agent' | 'environment';

/**
 * Host selection strategy for workspace-agent target.
 *
 * - `pinned` — specific hostId required, error if offline
 * - `any-matching` — any host with matching capability + workspace
 * - `prefer-local` — prefer hostType='local', fallback to cloud
 * - `prefer-cloud` — prefer hostType='cloud', fallback to local
 */
export type HostSelectionStrategy = 'pinned' | 'any-matching' | 'prefer-local' | 'prefer-cloud';

/**
 * Execution target affinity.
 *
 * Extended to support Workspace Agent routing (ADR-0052, ADR-0054).
 * Backwards compatible: existing code using only `environmentId` continues to work.
 */
export interface ExecutionTarget {
  /** Target type. When omitted, resolved from routing config. */
  type?: ExecutionTargetType;
  /** Specific environment/container ID */
  environmentId?: string;
  /** Logical workspace for routing to correct Workspace Agent */
  workspaceId?: string;
  /** Namespace for multi-tenancy */
  namespace?: string;
  /** Working directory override */
  workdir?: string;
  /** Pin to specific host */
  hostId?: string;
  /** Host selection strategy (default: 'any-matching') */
  hostSelection?: HostSelectionStrategy;
  /** Repo fingerprint for affinity routing */
  repoFingerprint?: string;
}

/**
 * Workspace configuration.
 */
export interface WorkspaceConfig {
  type?: 'local' | 'ephemeral';
  cwd?: string;
  repo?: {
    url: string;
    ref: string;
    commit?: string;
  };
  filter?: {
    include?: string[];
    exclude?: string[];
  };
  snapshotId?: string;
}

/**
 * Artifacts collection configuration.
 */
export interface ArtifactsConfig {
  outdir?: string;
  upload?: boolean;
  patterns?: string[];
}

/**
 * Canonical execution request.
 *
 * TDescriptor allows upper layers to provide strongly typed descriptors
 * while keeping core-contracts plugin-agnostic.
 */
export interface ExecutionRequest<TDescriptor = unknown> {
  /** Unique execution ID for this execution attempt */
  executionId: string;

  /** Runtime descriptor required by the execution runtime */
  descriptor: TDescriptor;

  /** Absolute plugin root */
  pluginRoot: string;

  /** Handler reference relative to pluginRoot */
  handlerRef: string;

  /** Optional named export from handler module */
  exportName?: string;

  /** Input payload for handler */
  input: unknown;

  /** Explicit environment values for this execution. */
  env?: Record<string, string | undefined>;

  /**
   * Host-only installed platform root used for runtime module resolution.
   * Remote backends use their own host root, not a caller-local filesystem path.
   */
  platformRoot?: string;

  /** Workspace strategy (default local) */
  workspace?: WorkspaceConfig;

  /** Artifacts collection settings */
  artifacts?: ArtifactsConfig;

  /** Timeout in milliseconds */
  timeoutMs?: number;

  /** Optional target affinity */
  target?: ExecutionTarget;

  /** Additional execution context */
  context?: {
    commandPath?: string;
    tenantId?: string;
    traceId?: string;
    sessionId?: string;
    [key: string]: unknown;
  };
}

/**
 * ExecutionRequest → RequestContext Mapping Rule
 *
 * When backend executes a request, it creates RequestContext for platform calls:
 *
 * ExecutionRequest → RequestContext:
 *   executionId     → ctx.executionId   (required, correlation ID)
 *   context.tenantId  → ctx.tenantId    (optional, multi-tenancy)
 *   context.traceId   → ctx.traceId     (optional, distributed tracing)
 *   [auth token]     → ctx.authToken    (from KB_PLATFORM_SOCKET_TOKEN)
 *
 * Example flow:
 * 1. CLI receives: { executionId: 'exec-123', context: { tenantId: 'acme' } }
 * 2. Backend passes to runner: platformAuthToken = platformServer.getAuthToken()
 * 3. Runner sets env vars: KB_EXECUTION_ID='exec-123', KB_TENANT_ID='acme', KB_PLATFORM_SOCKET_TOKEN='...'
 * 4. Worker reads env vars and creates RequestContext
 * 5. Every platform call includes: { executionId: 'exec-123', tenantId: 'acme', authToken: '...' }
 * 6. Platform server validates authToken, uses executionId for logging/correlation
 */
