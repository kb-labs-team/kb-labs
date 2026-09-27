import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ICache } from '@kb-labs/core-platform';
import {
  AgentLeaseError,
  DEFAULT_AGENT_LEASE_TTL_SECONDS,
  issueAgentLease,
  isAgentLeaseCallAllowed,
  resolveAgentLease,
  revokeAgentLease,
} from '../mcp/agent-leases.js';

function makeCache() {
  const store = new Map<string, unknown>();
  const get = vi.fn(async (key: string) => store.get(key) ?? null);
  const set = vi.fn(async (key: string, value: unknown) => { store.set(key, value); });
  const del = vi.fn(async (key: string) => { store.delete(key); });
  return { store, get, set, del, cache: { get, set, delete: del } as unknown as ICache };
}

const identity = {
  userId: 'user-1', namespaceId: 'team-1', type: 'user', tier: 'pro', permissions: [],
} as never;

describe('agent leases', () => {
  let memory: ReturnType<typeof makeCache>;
  beforeEach(() => { memory = makeCache(); });

  it('issues an opaque short-lived bearer without storing its raw value', async () => {
    const issued = await issueAgentLease(memory.cache, {
      executionId: 'exec-1', identity, allowedTools: ['workspace__status'],
    });
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.record.expiresAt - issued.record.issuedAt).toBeLessThanOrEqual(DEFAULT_AGENT_LEASE_TTL_SECONDS * 1000);
    expect([...memory.store.keys()]).not.toContain(issued.token);
    expect(await resolveAgentLease(memory.cache, issued.token)).toEqual(issued.record);
  });

  it('revokes a lease and rejects expired or unknown tokens', async () => {
    const issued = await issueAgentLease(memory.cache, {
      executionId: 'exec-1', identity, allowedTools: ['workspace__status'], ttlSeconds: 1,
    });
    const record = [...memory.store.values()][0] as { expiresAt: number };
    record.expiresAt = Date.now() - 1;
    expect(await resolveAgentLease(memory.cache, issued.token)).toBeNull();
    expect(await resolveAgentLease(memory.cache, 'unknown')).toBeNull();

    const live = await issueAgentLease(memory.cache, {
      executionId: 'exec-2', identity, allowedTools: ['workspace__status'],
    });
    await revokeAgentLease(memory.cache, live.token);
    expect(await resolveAgentLease(memory.cache, live.token)).toBeNull();
  });

  it('lets a child narrow tools and resource inputs, but prevents scope escalation', async () => {
    const parent = await issueAgentLease(memory.cache, {
      executionId: 'parent', identity,
      allowedTools: ['workspace__status', 'workspace__list'],
      inputEquals: { workspace__status: { server: 'staging' } },
      ttlSeconds: 600,
    });
    const child = await issueAgentLease(memory.cache, {
      executionId: 'child', identity,
      allowedTools: ['workspace__status'],
      inputEquals: { workspace__status: { server: 'staging', detail: 'summary' } },
      ttlSeconds: 120,
      parent: parent.record,
    });
    expect(child.record.expiresAt).toBeLessThanOrEqual(parent.record.expiresAt);
    expect(isAgentLeaseCallAllowed(child.record, 'workspace__status', { server: 'staging', detail: 'summary' })).toBe(true);
    expect(isAgentLeaseCallAllowed(child.record, 'workspace__status', { server: 'production', detail: 'summary' })).toBe(false);
    expect(isAgentLeaseCallAllowed(child.record, 'workspace__list', {})).toBe(false);

    await expect(issueAgentLease(memory.cache, {
      executionId: 'escalating', identity, allowedTools: ['workspace__deploy'], parent: parent.record,
    })).rejects.toMatchObject({ code: 'LEASE_ESCALATION' });
    await expect(issueAgentLease(memory.cache, {
      executionId: 'widening', identity, allowedTools: ['workspace__status'], parent: parent.record,
    })).rejects.toMatchObject({ code: 'LEASE_ESCALATION' });
  });

  it('rejects unsafe paths, unknown constrained tools, malformed scopes, and excessive TTLs', async () => {
    const cases = [
      { inputEquals: { workspace__status: { 'server.__proto__.x': 'staging' } } },
      { inputEquals: { workspace__deploy: { server: 'staging' } } },
      { inputEquals: [] },
      { ttlSeconds: 3601 },
    ];
    for (const options of cases) {
      await expect(issueAgentLease(memory.cache, {
        executionId: 'bad', identity, allowedTools: ['workspace__status'],
        ...options,
      } as Parameters<typeof issueAgentLease>[1])).rejects.toBeInstanceOf(AgentLeaseError);
    }
  });
});
