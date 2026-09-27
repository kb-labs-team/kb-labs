import type { SpawnAgentRequest, AgentPlatformMcpConfig } from '@kb-labs/agent-contracts';

export interface PlatformMcpLease {
  endpoint: string;
  accessToken: string;
  allowedTools: string[];
  expiresAt: string;
  revoke(): Promise<void>;
}

/**
 * Create one child lease against the platform MCP service. The current local
 * integration deliberately uses the daemon's explicit development PDP stub;
 * production caller identity/token acquisition remains behind this boundary.
 */
export async function issuePlatformMcpLease(
  config: AgentPlatformMcpConfig | undefined,
  request: Pick<SpawnAgentRequest, 'subagentId' | 'mcpTools' | 'mcpInputEquals'>,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<PlatformMcpLease> {
  if (!config?.endpoint) {
    throw new Error('agents.platformMcp.endpoint must be configured to delegate platform MCP tools');
  }
  if (config.developmentPdpStub !== true) {
    throw new Error('Platform MCP lease authentication is not configured; enable the development PDP stub for local testing');
  }
  if (!request.subagentId || !request.mcpTools?.length) {
    throw new Error('A sub-agent ID and MCP tool selection are required');
  }

  const endpoint = validateMcpEndpoint(config.endpoint);
  const allAuthorizedTools = request.mcpTools.length === 1 && request.mcpTools[0] === '*';
  const response = await fetcher(`${endpoint}/leases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      executionId: request.subagentId,
      ...(allAuthorizedTools ? { allAuthorizedTools: true } : { allowedTools: request.mcpTools }),
      inputEquals: request.mcpInputEquals ?? {},
      ttlSeconds: 600,
    }),
    signal,
  });
  const body = await readJson(response);
  if (!response.ok) {
    const code = isRecord(body) && typeof body.code === 'string' ? ` (${body.code})` : '';
    throw new Error(`Platform MCP lease request failed: HTTP ${response.status}${code}`);
  }
  if (!isRecord(body)
    || body.tokenType !== 'Bearer'
    || typeof body.accessToken !== 'string'
    || body.accessToken.length < 32
    || !Array.isArray(body.allowedTools)
    || body.allowedTools.some((tool) => typeof tool !== 'string')
    || typeof body.expiresAt !== 'string') {
    throw new Error('Platform MCP lease endpoint returned an invalid response');
  }

  const allowedTools = body.allowedTools as string[];
  if (allowedTools.length === 0
    || (!allAuthorizedTools && (allowedTools.length !== request.mcpTools.length
      || request.mcpTools.some((tool) => !allowedTools.includes(tool))))) {
    await revokeLease(fetcher, endpoint, body.accessToken);
    throw new Error('Platform MCP lease grant did not match the requested scope');
  }

  let revoked = false;
  return {
    endpoint,
    accessToken: body.accessToken,
    allowedTools,
    expiresAt: body.expiresAt,
    async revoke() {
      if (revoked) { return; }
      revoked = true;
      await revokeLease(fetcher, endpoint, body.accessToken as string);
    },
  };
}

export function validateMcpEndpoint(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch {
    throw new Error('Platform MCP endpoint must be an absolute HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)
    || !url.pathname.replace(/\/$/, '').endsWith('/api/v1/mcp')
    || url.search || url.hash || url.username || url.password) {
    throw new Error('Platform MCP endpoint must end in /api/v1/mcp and must not contain credentials, query, or fragment');
  }
  return `${url.origin}${url.pathname.replace(/\/$/, '')}`;
}

async function revokeLease(fetcher: typeof fetch, endpoint: string, token: string): Promise<void> {
  const response = await fetcher(`${endpoint}/leases/current`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Platform MCP lease revocation failed: HTTP ${response.status}`);
  }
}

async function readJson(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { return null; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
