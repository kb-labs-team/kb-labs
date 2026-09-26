/**
 * @module @kb-labs/host-app
 * Machine-level host library entry. Importing this module has no side effects;
 * the `kb-host` executable lives in `bin.ts`.
 */

export { createHostConfig, startHost, HOST_APP_ID, type HostOptions } from "./host.js";
export { HostExposureRefusedError } from "./errors.js";
export { applyHostGatewayPolicy, type HostGatewayPolicy } from "./policy.js";
export {
  HOST_MODULE_IDS,
  parseHostSettings,
  type HostAuthMode,
  type HostModuleId,
  type HostSettings,
} from "./settings.js";
