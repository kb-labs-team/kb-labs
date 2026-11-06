/**
 * @module cli-core/gateway/transport-resolver
 *
 * Determines which transport to use for CLI → Gateway communication.
 *
 * Priority:
 *   1. Host Agent IPC socket (~/.kb/agent.sock) — for workspace agent / same-host deployment
 *   2. Gateway address resolved by the CLI bootstrap owner
 *
 * NOTE: credentials.json is intentionally NOT used for execution routing.
 * It is a registry/identity credential file (tokens, handle) — not platform topology config.
 * The execution gateway URL must be provided by the CLI bootstrap resolver.
 * Auth tokens for the HTTP transport are still loaded from credentials.json when available.
 */

import * as path from 'node:path';
import * as os from 'node:os';
import * as net from 'node:net';
import type { IGatewayClient } from '@kb-labs/sdk/gateway';
import { HttpSseGatewayTransport } from './http-sse-transport.js';
import { HostAgentTransport } from './host-agent-transport.js';
import { getHostServiceAddress } from '@kb-labs/core-platform';

/** Default Host Agent IPC socket path */
const HOST_AGENT_SOCKET = path.join(os.homedir(), '.kb', 'agent.sock');

/**
 * Resolve the execution transport for a Gateway selected by the CLI bootstrap owner.
 */
export async function resolveTransport(gatewayUrl: string): Promise<IGatewayClient> {
  // 1. Host Agent IPC socket (same-host deployment, workspace agent)
  if (await isSocketAlive(HOST_AGENT_SOCKET)) {
    return new HostAgentTransport(HOST_AGENT_SOCKET);
  }

  // 2. Gateway address selected by the single CLI topology owner.
  return new HttpSseGatewayTransport({
    gatewayUrl: getHostServiceAddress('gateway', { KB_GATEWAY_URL: gatewayUrl }),
    credentialKind: 'either',
  });
}

/**
 * Check if a Unix socket is alive (accepts connections).
 */
async function isSocketAlive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const client = net.createConnection({ path: socketPath }, () => {
      client.destroy();
      resolve(true);
    });
    client.on('error', () => {
      resolve(false);
    });
    // Timeout after 500ms
    client.setTimeout(500, () => {
      client.destroy();
      resolve(false);
    });
  });
}
