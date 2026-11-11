import { describe, it, expect, vi } from 'vitest';
import handler from '../../src/handlers/create-branch.js';

const BASE_SHA = 'abc123def456abc123def456abc123def456abc1';

function makeFetch(responses: Array<{ status: number; body: unknown }>) {
  let i = 0;
  return vi.fn(async () => {
    const r = responses[i++]!;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    };
  });
}

function makeCtx(fetch: ReturnType<typeof vi.fn>) {
  return { runtime: { fetch } } as any;
}

const INPUT = { owner: 'acme', repo: 'myrepo', branchName: 'feat/fix-123', fromBranch: 'main' };

describe('create-branch handler', () => {
  it('BUG-BC-001: creates branch when it does not exist', async () => {
    const fetch = makeFetch([
      { status: 200, body: { object: { sha: BASE_SHA } } },
      { status: 201, body: { ref: `refs/heads/${INPUT.branchName}`, object: { sha: BASE_SHA } } },
    ]);
    const result = await handler.execute(makeCtx(fetch), INPUT);
    expect(result).toMatchObject({ branchName: INPUT.branchName, sha: BASE_SHA });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('BUG-BC-002: force-resets existing branch to fromBranch SHA on 422', async () => {
    const fetch = makeFetch([
      { status: 200, body: { object: { sha: BASE_SHA } } },
      { status: 422, body: { message: 'Reference already exists' } },
      { status: 200, body: { ref: `refs/heads/${INPUT.branchName}`, object: { sha: BASE_SHA } } },
    ]);
    const result = await handler.execute(makeCtx(fetch), INPUT);
    expect(result).toMatchObject({ branchName: INPUT.branchName, sha: BASE_SHA });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining(`/git/refs/heads/${INPUT.branchName}`),
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ sha: BASE_SHA, force: true }) }),
    );
  });

  it('BUG-BC-003: returns same sha after force-reset (not stale sha from old branch)', async () => {
    const STALE_SHA = '0000000000000000000000000000000000000000';
    const fetch = makeFetch([
      { status: 200, body: { object: { sha: BASE_SHA } } },
      { status: 422, body: { message: 'Reference already exists' } },
      { status: 200, body: { ref: `refs/heads/${INPUT.branchName}`, object: { sha: BASE_SHA } } },
    ]);
    void STALE_SHA;
    const result = await handler.execute(makeCtx(fetch), INPUT);
    // sha in response must be fromBranch SHA, not whatever was in the old branch
    expect(result!.sha).toBe(BASE_SHA);
  });
});
