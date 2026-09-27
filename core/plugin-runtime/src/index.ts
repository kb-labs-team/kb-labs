/**
 * @kb-labs/plugin-runtime
 *
 * V3 Plugin System Runtime - Context factory, sandboxed shims, and APIs.
 */

// Context
export {
  createPluginContextV3,
  createTraceContext,
  createStreamingUI,
  type CreateContextOptions,
  type CreateContextResult,
  type CreateTraceContextOptions,
} from './context/index.js';

// Runtime (sandboxed shims)
export {
  createRuntimeAPI,
  createFSShim,
  createFetchShim,
  createEnvShim,
  type CreateFSShimOptions,
  type CreateRuntimeAPIOptions,
} from './runtime/index.js';

// API
export {
  createPluginAPI,
  createLifecycleAPI,
  createStateAPI,
  createArtifactsAPI,
  createShellAPI,
  createEventsAPI,
  createNoopEventsAPI,
  createInvokeAPI,
  createNoopInvokeAPI,
  createWorkflowsAPI,
  createNoopWorkflowsAPI,
  createJobsAPI,
  createNoopJobsAPI,
  createEnvironmentAPI,
  createNoopEnvironmentAPI,
  createWorkspaceAPI,
  createNoopWorkspaceAPI,
  createSnapshotAPI,
  createNoopSnapshotAPI,
  executeCleanup,
  type CreatePluginAPIOptions,
  type EventEmitterFn,
  type PluginInvokerFn,
} from './api/index.js';

// Utils
export {
  createId,
  createShortId,
  extractTraceId,
  createRequestId,
} from './utils/index.js';

// Sandbox
export {
  runInProcess,
  runInSubprocess,
  type RunInProcessOptions,
  type RunInSubprocessOptions,
} from './sandbox/index.js';

export {
  createDefaultProcessExecutor,
  DarwinProcessBackend,
  LinuxProcessBackend,
  GovernedProcessError,
  BrokeredProcessExecutor,
} from './process/index.js';

// Platform governance
export { createGovernedPlatformServices } from './platform/governed.js';
export { resolveAdapterMiddlewares } from './platform/middleware-loader.js';
export type { RawMiddlewareDecl } from './platform/middleware-loader.js';
export type { LoadedMiddleware, PlatformConfig } from './platform/pipeline.js';
export { assemblePlatform, makeAssemblyHook } from './platform/index.js';
export { ADAPTER_REGISTRY_KEYS } from './platform/index.js';
export {
  wrapDocumentDatabase,
  wrapKVStore,
  validateDatabaseGrants,
} from './platform/database-governance.js';
export type { ManifestForGrantValidation } from './platform/database-governance.js';

// Host Wrappers
export {
  wrapCliResult,
  wrapRestResult,
  unwrapRestData,
  type RestResultWithMeta,
} from './host/index.js';

// Re-export contracts for convenience
export type {
  PluginContextV3,
  PluginContextDescriptor,
  HostContext,
  HostType,
  PermissionSpec,
  UIFacade,
  Spinner,
  TraceContext,
  PluginServices,
  PlatformServices,
  RuntimeAPI,
  PluginAPI,
  CleanupFn,
  // Runner types
  RunResult,
  ExecutionMeta,
  // CLI types (for wrapCliResult)
  CommandResult,
  CommandSuccess,
  CommandFailure,
  CommandError,
  CommandResultWithMeta,
  StandardMeta,
} from '@kb-labs/plugin-contracts';

// One copy of the platform at runtime (ADR-0048 D5)
export {
  installPlatformResolveHook,
  PlatformDuplicateError,
  isPlatformPackage,
  platformPackageOf,
  type PlatformOverrideDiagnostic,
  type PlatformResolveHook,
  type PlatformResolveHookOptions,
} from './platform-resolve/index.js';
