import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/core/index.js', () => ({
  applyCommitPlan: vi.fn(),
  loadPlan: vi.fn(),
  saveToHistory: vi.fn(),
  clearPlan: vi.fn(),
}));

vi.mock('@kb-labs/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kb-labs/sdk')>();
  return {
    ...actual,
    useLoader: vi.fn(() => ({
      start: vi.fn(),
      stop: vi.fn(),
      succeed: vi.fn(),
      fail: vi.fn(),
    })),
    useConfig: vi.fn().mockResolvedValue({}),
    findRepoRoot: vi.fn().mockResolvedValue('/project'),
  };
});

vi.mock('../../src/rest/handlers/scope-resolver.js', () => ({
  resolveScopePath: vi.fn((_cwd: string, _scope: string) => _cwd),
}));

import { loadPlan, applyCommitPlan, saveToHistory, clearPlan } from '../../src/core/index.js';
import { createCapturedUI, createMockContext } from '@kb-labs/sdk/testing';
import applyCommand from '../../src/cli/commands/apply.js';

interface ApplyInput {
  force?: boolean;
  json?: boolean;
  scope?: string;
}

const mockPlan = {
  commits: [
    { groupId: 'g1', message: 'feat: add feature', files: ['a.ts'] },
    { groupId: 'g2', message: 'fix: fix bug', files: ['b.ts'] },
  ],
};

const mockApplyResult = {
  success: true,
  appliedCommits: [
    { groupId: 'g1', sha: 'abc1234', message: 'feat: add feature' },
    { groupId: 'g2', sha: 'def5678', message: 'fix: fix bug' },
  ],
  errors: [],
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(loadPlan).mockResolvedValue(mockPlan as never);
  vi.mocked(applyCommitPlan).mockResolvedValue(mockApplyResult as never);
  vi.mocked(saveToHistory).mockResolvedValue(undefined);
  vi.mocked(clearPlan).mockResolvedValue(undefined);
});

describe('commit:apply', () => {
  it('APPLY-01: applies plan and prints success', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    const result = await applyCommand.execute(ctx as never, { force: false, json: false, scope: 'root' } as ApplyInput);

    expect(result).not.toHaveProperty('ok');
    expect(applyCommitPlan).toHaveBeenCalledOnce();
    expect(captured.success.length).toBeGreaterThan(0);
  });

  it('APPLY-02: --json outputs structured result', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    const result = await applyCommand.execute(ctx as never, { force: false, json: true, scope: 'root' } as ApplyInput);

    expect(result).toMatchObject({ success: true });
  });

  it('APPLY-03: --dry-run shows intent without executing', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    const result = await applyCommand.execute(ctx as never, {
      flags: { 'dry-run': true, force: false, json: false, scope: 'root' },
      argv: [],
    } as never);

    expect(result).toMatchObject({ summary: expect.stringContaining('Apply current commit plan'), operations: expect.any(Array) });
    expect(applyCommitPlan).not.toHaveBeenCalled();
    expect(captured.infos[0]?.message).toContain('Dry-run');
  });

  it('APPLY-04: no plan returns exitCode 1', async () => {
    vi.mocked(loadPlan).mockResolvedValue(null as never);
    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    const result = await applyCommand.execute(ctx as never, { force: false, json: false, scope: 'root' } as ApplyInput);

    if (!('ok' in result) || result.ok) throw new Error('Expected apply failure result');
    expect(applyCommitPlan).not.toHaveBeenCalled();
  });

  it('APPLY-05: empty plan exits 0 without applying', async () => {
    vi.mocked(loadPlan).mockResolvedValue({ commits: [] } as never);
    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    const result = await applyCommand.execute(ctx as never, { force: false, json: false, scope: 'root' } as ApplyInput);

    expect(result).toMatchObject({ success: true, commits: [], errors: [] });
    expect(applyCommitPlan).not.toHaveBeenCalled();
  });
});
