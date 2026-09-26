/**
 * @module @kb-labs/gateway-app
 * Gateway library entry. Importing this module has no side effects; the
 * `gateway-app` executable lives in `bin.ts`.
 */

export {
  bootstrap,
  setup,
  startGateway,
  isLoopbackHost,
  type GatewayEmbedOptions,
} from "./bootstrap.js";
export { loadGatewayConfig } from "./config.js";
export { resolvePublicUrl } from "./server.js";
