import { describe, expect, it, vi } from 'vitest';
import { issuePlatformMcpLease, validateMcpEndpoint } from '../platform-mcp-lease.js';

const config = {
  endpoint: 'http://127.0.0.1:7779/api/v1/mcp',
  developmentPdpStub: true,
};

describe('platform MCP lease client', () => {
  it('requests a scoped lease without sending a user bearer and revokes it once', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        tokenType: 'Bearer', accessToken: 'child-lease-token-'.padEnd(40, 'x'),
        executionId: 'child-1', allowedTools: ['host-agent__workspace_status'],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }), { status: 201 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const lease = await issuePlatformMcpLease(config, {
      subagentId: 'child-1', mcpTools: ['host-agent__workspace_status'],
      mcpInputEquals: { 'host-agent__workspace_status': { server: 'staging' } },
    }, fetcher as typeof fetch);

    expect(fetcher).toHaveBeenNthCalledWith(1, 'http://127.0.0.1:7779/api/v1/mcp/leases', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        executionId: 'child-1',
        allowedTools: ['host-agent__workspace_status'],
        inputEquals: { 'host-agent__workspace_status': { server: 'staging' } },
        ttlSeconds: 600,
      }),
    }));
    expect(fetcher.mock.calls[0]?.[1]).not.toHaveProperty('headers.Authorization');
    expect(lease.allowedTools).toEqual(['host-agent__workspace_status']);

    await lease.revoke();
    await lease.revoke();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:7779/api/v1/mcp/leases/current', {
      method: 'DELETE', headers: { Authorization: `Bearer ${lease.accessToken}` },
    });
  });

  it('asks the platform to resolve all currently authorized tools only for the explicit wildcard', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      tokenType: 'Bearer', accessToken: 'child-lease-token-'.padEnd(40, 'x'),
      executionId: 'child-2', allowedTools: ['plugin__read', 'plugin__write'],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }), { status: 201 }));

    await issuePlatformMcpLease(config, { subagentId: 'child-2', mcpTools: ['*'] }, fetcher as typeof fetch);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      executionId: 'child-2', allAuthorizedTools: true,
    });
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).not.toHaveProperty('allowedTools');
  });

  it('fails closed on missing endpoint, non-stub auth, denied issuance, and widened grants', async () => {
    await expect(issuePlatformMcpLease(undefined, { subagentId: 'x', mcpTools: ['tool'] }))
      .rejects.toThrow(/endpoint must be configured/);
    await expect(issuePlatformMcpLease({ ...config, developmentPdpStub: false }, { subagentId: 'x', mcpTools: ['tool'] }))
      .rejects.toThrow(/authentication is not configured/);

    const denied = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }));
    await expect(issuePlatformMcpLease(config, { subagentId: 'x', mcpTools: ['tool'] }, denied as typeof fetch))
      .rejects.toThrow('HTTP 401');

    const widened = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        tokenType: 'Bearer', accessToken: 'child-lease-token-'.padEnd(40, 'x'),
        allowedTools: ['tool', 'other'], expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }), { status: 201 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(issuePlatformMcpLease(config, { subagentId: 'x', mcpTools: ['tool'] }, widened as typeof fetch))
      .rejects.toThrow(/did not match the requested scope/);
    expect(widened).toHaveBeenCalledTimes(2);
  });

  it('validates MCP URL shape and rejects credentials/query/other endpoints', () => {
    expect(validateMcpEndpoint('https://gateway.example/prefix/api/v1/mcp'))
      .toBe('https://gateway.example/prefix/api/v1/mcp');
    expect(() => validateMcpEndpoint('https://user:secret@gateway.example/api/v1/mcp')).toThrow(/must end/);
    expect(() => validateMcpEndpoint('https://gateway.example/api/v1/mcp?token=x')).toThrow(/must end/);
    expect(() => validateMcpEndpoint('file:///tmp/mcp')).toThrow(/must end/);
  });
});
