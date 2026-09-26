/**
 * @module @kb-labs/host-app
 * Machine-level host library entry. Importing this module has no side effects;
 * the `kb-host` executable lives in `bin.ts`.
 */

export {
  createHostConfig,
  startHost,
  HOST_APP_ID,
  type HostOptions,
  type ProjectRuntimeOverrides,
} from "./host.js";
export { HostExposureRefusedError } from "./errors.js";
export {
  ProjectRuntimeManager,
  type ManagerSnapshot,
  type ProjectRuntimeManagerOptions,
  type RestartPolicy,
  type RuntimeLauncher,
  type RuntimeLease,
  type RuntimeProcess,
  type RuntimeProject,
  type RuntimeSnapshot,
} from "./project-runtime/manager.js";
export {
  createChildProcessLauncher,
  probeRuntime,
  type ChildProcessLauncherOptions,
} from "./project-runtime/launcher.js";
export { createProjectRouting } from "./project-runtime/routing.js";
export {
  ProjectRuntimeError,
  runtimeLimitReached,
  runtimeStartFailed,
} from "./project-runtime/errors.js";
export { applyHostGatewayPolicy, type HostGatewayPolicy } from "./policy.js";
export {
  HOST_MODULE_IDS,
  parseHostSettings,
  type HostAuthMode,
  type HostModuleId,
  type HostSettings,
} from "./settings.js";
