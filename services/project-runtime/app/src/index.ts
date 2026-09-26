/**
 * @module @kb-labs/project-runtime-app
 * Project runtime library entry. Importing this module has no side effects;
 * the `kb-project-runtime` executable lives in `bin.ts`.
 */

export {
  createProjectRuntimeConfig,
  DEFAULT_PROJECT_MODULES,
  PROJECT_RUNTIME_APP_ID,
  type ProjectRuntimeModule,
  type ProjectRuntimeOptions,
} from "./runtime.js";
export {
  parseListen,
  parseRuntimeArgs,
  RuntimeArgsError,
  type RuntimeArgs,
  type RuntimeListenAddress,
} from "./args.js";
export { createRuntimeGuard, tokenMatches, type RuntimeGuard } from "./guard.js";
export { watchParent, isProcessAlive } from "./watchdog.js";
export {
  RUNTIME_ARGS,
  RUNTIME_HEALTH_PATH,
  RUNTIME_PROJECT_HEADER,
  RUNTIME_TOKEN_ENV,
  RUNTIME_TOKEN_HEADER,
  type RuntimeHealth,
} from "./protocol.js";
