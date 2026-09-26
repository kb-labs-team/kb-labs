/**
 * @module @kb-labs/gateway-app
 * Gateway library entry. Importing this module has no side effects; the
 * `gateway-app` executable lives in `bin.ts`.
 */

export { bootstrap, setup } from "./bootstrap.js";
export { resolvePublicUrl } from "./server.js";
