/**
 * Daemon — main runtime loop.
 *
 * Lifecycle:
 *   1. Load ~/.kb/agent.json
 *   2. TokenManager.start() → fetch initial token pair from Gateway
 *   3. GatewayClient.connect() → WSS handshake
 *   4. Register capability handlers (filesystem, git)
 *   5. IpcServer.start() → Unix socket for CLI/Studio
 *   6. Wait for SIGTERM/SIGINT → graceful shutdown
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { GatewayClient, GatewayTransport, IpcServer, TokenManager, type TokenPair } from '@kb-labs/host-agent-core';
import { FilesystemHandler, SearchHandler, ShellHandler } from '@kb-labs/host-agent-fs';
import { AgentConfigSchema, TokenPairSchema } from '@kb-labs/host-agent-contracts';
import { createTransport } from '@kb-labs/host-agent-transport';
import { ExecutionHandler } from './handlers/execution-handler.js';

const AGENT_CONFIG_PATH = join(homedir(), '.kb', 'agent.json');
const AGENT_VERSION = '0.1.0';

async function parseTokenResponse(res: Response, context: string): Promise<TokenPair> {
  if (!res.ok) { throw new Error(`${context}: HTTP ${res.status}`); }
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) {
    throw new Error(`${context}: unexpected content-type: ${ct}`);
  }
  const body: unknown = await res.json();
  const parsed = TokenPairSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(`${context}: invalid token response: ${parsed.error.message}`);
  }
  return parsed.data;
}

function assertSecureUrl(url: string, context: string): void {
  if (!url.startsWith('https://') && !url.startsWith('http://localhost') && !url.startsWith('http://127.0.0.1')) {
    throw new Error(`${context}: insecure URL rejected — must use HTTPS (got ${url})`);
  }
}

async function fetchTokens(gatewayUrl: string, clientId: string, clientSecret: string): Promise<TokenPair> {
  assertSecureUrl(gatewayUrl, 'fetchTokens');
  const res = await fetch(`${gatewayUrl}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, clientSecret }),
  });
  return parseTokenResponse(res, 'fetchTokens');
}

async function refreshTokens(gatewayUrl: string, refreshToken: string): Promise<TokenPair> {
  const res = await fetch(`${gatewayUrl}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  return parseTokenResponse(res, 'refreshTokens');
}

export async function startDaemon(): Promise<void> {
  // 1. Load config
  let raw: string;
  try {
    raw = await readFile(AGENT_CONFIG_PATH, 'utf-8');
  } catch {
    throw new Error(`Agent config not found at ${AGENT_CONFIG_PATH}. Run 'kb agent register' first.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Agent config at ${AGENT_CONFIG_PATH} contains invalid JSON.`);
  }
  const result = AgentConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Agent config validation failed: ${result.error.message}`);
  }
  const config = result.data;

  // 2. Token manager
  let wsReconnect: (() => void) | null = null;

  const tokenManager = new TokenManager({
    fetchTokens: () => fetchTokens(config.gatewayUrl, config.clientId, config.clientSecret),
    refreshTokens: (rt) => refreshTokens(config.gatewayUrl, rt),
    onRefreshed: () => {
      // Token rotated — trigger WS reconnect so new token is used
      wsReconnect?.();
    },
    onRefreshFailed: (err) => {
      console.error('[workspace-agent] Token refresh permanently failed, exiting:', err.message);
      process.exit(1);
    },
  });

  // 3. Gateway WS client
  let connected = false;

  const gatewayClient = new GatewayClient({
    gatewayUrl: config.gatewayUrl,
    agentVersion: AGENT_VERSION,
    capabilities: ['filesystem', 'git', 'execution'],
    hostType: config.hostType,
    getAccessToken: () => tokenManager.accessToken,
    onConnected: (hostId, sessionId) => {
      connected = true;
      console.log(`[workspace-agent] Connected: hostId=${hostId} session=${sessionId}`);
    },
    onDisconnected: () => {
      connected = false;
      console.log('[workspace-agent] Disconnected, reconnecting...');
    },
    onTokenExpired: async () => {
      // Will be handled by TokenManager — no action needed
    },
  });

  wsReconnect = () => {
    gatewayClient.stop();
    void gatewayClient.connect();
  };

  // 4. Register capability handlers (restricted to declared workspacePaths only)
  const fsHandler = new FilesystemHandler({
    allowedPaths: config.workspacePaths,
  });
  gatewayClient.registerHandler('filesystem', (call) => fsHandler.handle(call));

  const searchHandler = new SearchHandler({ allowedPaths: config.workspacePaths });
  gatewayClient.registerHandler('search', (call) => searchHandler.handle(call));

  const shellHandler = new ShellHandler({ allowedPaths: config.workspacePaths });
  gatewayClient.registerHandler('shell', (call) => shellHandler.handle(call));

  // 5. Execution capability — Workspace Agent can execute plugins locally
  const gatewayTransport = new GatewayTransport(gatewayClient, {
    namespaceId: config.namespaceId,
    hostId: config.hostId,
  });

  const executionHandler = new ExecutionHandler({
    gatewayTransport,
    allowedPaths: config.workspacePaths,
    executionMode: config.execution.mode,
    timeoutMs: config.execution.timeoutMs,
    allowedPlugins: config.execution.allowedPlugins,
  });

  gatewayClient.registerHandler('execution', (call) => executionHandler.handle(call));

  // 6. IPC server — transport auto-selects unix socket / named pipe / tcp by platform
  const ipcTransport = createTransport({ mode: 'auto' });
  const ipcServer = new IpcServer({
    transport: ipcTransport,
    getStatus: () => ({
      connected,
      hostId: config.hostId,
      gatewayUrl: config.gatewayUrl,
      reconnecting: !connected,
    }),
    gatewayClient,
  });

  // Start everything
  await tokenManager.start();
  console.log('[workspace-agent] Token acquired');

  await gatewayClient.connect();
  await ipcServer.start();
  console.log('[workspace-agent] IPC transport started');

  // 6. Graceful shutdown
  const shutdown = (): void => {
    console.log('[workspace-agent] Shutting down...');
    executionHandler.stop();
    tokenManager.stop();
    gatewayClient.stop();
    ipcServer.stop();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
