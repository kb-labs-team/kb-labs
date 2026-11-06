import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/core/index.js', () => ({
  clearPlan: vi.fn(),
  hasPlan: vi.fn(),
}));

vi.mock('@kb-labs/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kb-labs/sdk')>();
  return {
    ...actual,
    findRepoRoot: vi.fn().mockResolvedValue('/project'),
  };
});

import { clearPlan, hasPlan } from '../../src/core/index.js';
import { createCapturedUI, createMockContext } from '@kb-labs/sdk/testing';
import resetCommand from '../../src/cli/commands/reset.js';

interface ResetInput {
  scope?: string;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(hasPlan).mockResolvedValue(true);
  vi.mocked(clearPlan).mockResolvedValue(undefined);
});

describe('commit:reset', () => {
  it('RESET-01: clears existing plan and prints success', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    const result = await resetCommand.execute(ctx as never, {} as ResetInput);

    expect(result).toMatchObject({ success: true, message: 'Commit plan cleared successfully.' });
    expect(clearPlan).toHaveBeenCalledOnce();
    expect(captured.success.length).toBeGreaterThan(0);
  });

  it('RESET-02: no plan exits 0 with info message', async () => {
    vi.mocked(hasPlan).mockResolvedValue(false);
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    const result = await resetCommand.execute(ctx as never, {} as ResetInput);

    expect(result).toMatchObject({ success: true, message: 'No commit plan to clear.' });
    expect(clearPlan).not.toHaveBeenCalled();
    expect(captured.infos.length).toBeGreaterThan(0);
  });

  it('RESET-03: --dry-run shows intent without clearing', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    const result = await resetCommand.execute(ctx as never, {
      flags: { 'dry-run': true, scope: 'root' },
      argv: [],
    } as never);

    expect(result).toMatchObject({ summary: expect.stringContaining('Clear commit plan'), operations: expect.any(Array) });
    expect(clearPlan).not.toHaveBeenCalled();
    expect(captured.infos[0]?.message).toContain('Dry-run');
  });

  it('RESET-04: scope is passed to clearPlan', async () => {
    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    await resetCommand.execute(ctx as never, { scope: 'backend' } as ResetInput);

    expect(clearPlan).toHaveBeenCalledWith(expect.any(String), 'backend');
  });
});
