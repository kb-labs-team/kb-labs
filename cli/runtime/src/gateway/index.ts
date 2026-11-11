/**
 * @module cli-core/gateway
 *
 * Gateway client SDK for CLI thin client.
 * CLI connects to Gateway server for handler execution,
 * receiving streaming ExecutionEvents.
 */

export { HttpSseGatewayTransport } from './http-sse-transport.js';
export { TerminalEventRenderer } from './renderer.js';
export type { IEventRenderer } from './renderer.js';
export { HostAgentTransport } from './host-agent-transport.js';
export { resolveTransport } from './transport-resolver.js';
export { hasUsablePlatformAuth } from './platform-auth.js';
export { resolveActiveGateway, resolveActiveGatewayAddress } from './active-gateway.js';
export type { ResolveActiveGatewayOptions } from './active-gateway.js';
