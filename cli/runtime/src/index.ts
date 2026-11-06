/**
 * @module @kb-labs/cli-runtime
 * CLI runtime — command execution, middleware, formatters, presenters,
 * gateway, lifecycle, and all CLI-specific infrastructure.
 *
 * This package contains everything that was previously in @kb-labs/cli-core
 * except catalog ownership, whose reader contract lives in plugin-contracts.
 */

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

export {
  MiddlewareManager,
  type CommandMiddleware,
  type MiddlewareConfig,
} from './middleware/middleware-manager.js';

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

export {
  FormattersRegistry,
  type OutputFormatter,
} from './formatters/formatters-registry.js';
export { jsonFormatter } from './formatters/builtin/json.js';
export { yamlFormatter } from './formatters/builtin/yaml.js';
export { tableFormatter } from './formatters/builtin/table.js';
export { markdownFormatter } from './formatters/builtin/markdown.js';

// ---------------------------------------------------------------------------
// Runtime context
// ---------------------------------------------------------------------------

export { createRuntimeContext } from './context/runtime-context.js';
export {
  createCliRuntime,
  type CliRuntime,
  type RuntimeSetupOptions,
} from './runtime.js';

// ---------------------------------------------------------------------------
// CLI Context (from cli-core)
// ---------------------------------------------------------------------------

export { createContext, type SystemContext } from './cli-context.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export {
  EXIT_CODES,
  CLI_ERROR_CODES,
  CliError,
  mapCliErrorToExitCode,
} from './errors.js';

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

export { parseArgs } from './flags.js';

// ---------------------------------------------------------------------------
// Platform Logger
// ---------------------------------------------------------------------------

export {
  getLogger,
  getLogLevel,
  type Logger,
} from './platform-logger.js';

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

export * from './io/types.js';

// ---------------------------------------------------------------------------
// Presenters
// ---------------------------------------------------------------------------

export * from './presenter/types.js';
export { createTextPresenter } from './presenter/text.js';
export { createJsonPresenter } from './presenter/json.js';
export { colors } from './presenter/colors.js';
export { createLoader } from './presenter/loader.js';
export { registerSecretFlagValues, type CommandFlagValueDeclaration } from './secret-flags.js';

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

export * from './telemetry/types.js';

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export {
  LifecycleManager,
  type IManifestProvider,
  type PluginLifecycle,
  type ExecutionLimits,
  type CliContext,
} from './lifecycle/lifecycle-manager.js';

// ---------------------------------------------------------------------------
// V3 Plugin System (re-exported, sub-path also available)
// ---------------------------------------------------------------------------

export { executeCommandV3 } from './v3/index.js';
