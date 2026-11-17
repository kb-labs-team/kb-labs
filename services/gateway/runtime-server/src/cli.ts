/**
 * @module @kb-labs/gateway-runtime-server/cli
 *
 * CLI entry point for the runtime server.
 * Run inside an isolation: strict container to handle remote plugin execution.
 *
 * Required env vars:
 *   GATEWAY_WS_URL    — WebSocket URL of the Gateway (e.g. ws://gateway:4000)
 *   RUNTIME_HOST_ID   — Deterministic hostId assigned by workflow-daemon (e.g. runtime-abc123)
 *   GATEWAY_TOKEN     — Bearer token for WS auth
 */

import { RuntimeServer } from './runtime-server.js';

const gatewayUrl = process.env['GATEWAY_WS_URL'];
const hostId = process.env['RUNTIME_HOST_ID'];
const token = process.env['GATEWAY_TOKEN'];

if (!gatewayUrl) {
  process.stderr.write('[runtime-server] FATAL: GATEWAY_WS_URL is required\n');
  process.exit(1);
}
if (!hostId) {
  process.stderr.write('[runtime-server] FATAL: RUNTIME_HOST_ID is required\n');
  process.exit(1);
}
if (!token) {
  process.stderr.write('[runtime-server] FATAL: GATEWAY_TOKEN is required\n');
  process.exit(1);
}

const server = new RuntimeServer({
  gatewayUrl,
  getAccessToken: () => token,
  agentVersion: '0.1.0',
  platformRoot: process.env.KB_PLATFORM_ROOT,
});

process.on('SIGTERM', () => {
  server.stop();
  process.exit(0);
});

process.on('SIGINT', () => {
  server.stop();
  process.exit(0);
});

server.start().catch((err: unknown) => {
  process.stderr.write(`[runtime-server] Failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
