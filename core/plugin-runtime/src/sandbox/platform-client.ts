/**
 * Canonical platform client for sandboxed plugins.
 *
 * This module intentionally does not hand-maintain adapter RPC methods. The
 * worker receives the same proxy platform assembled by `@kb-labs/core-ipc`,
 * which is checked against the platform transport policy.
 */

import type { PlatformServices } from '@kb-labs/plugin-contracts';
import {
  createProxyPlatform,
  UnixSocketTransport,
} from '@kb-labs/core-ipc';
import type { LLMRouterMetadata } from '@kb-labs/core-platform';

let transport: UnixSocketTransport | null = null;

/** Connect a sandbox worker to the parent platform through canonical IPC proxies. */
export async function connectToPlatform(socketPath?: string, llmRouting?: LLMRouterMetadata): Promise<PlatformServices> {
  if (!socketPath) {
    throw new Error('Socket path is required for platform RPC connection');
  }

  transport = new UnixSocketTransport({
    socketPath,
    authToken: process.env.KB_PLATFORM_SOCKET_TOKEN,
  });
  await transport.connect();

  return createProxyPlatform({ transport, llmRouting });
}

/** Disconnect the current sandbox worker from its parent platform. */
export async function disconnectFromPlatform(): Promise<void> {
  if (!transport) { return; }
  await transport.close();
  transport = null;
}
