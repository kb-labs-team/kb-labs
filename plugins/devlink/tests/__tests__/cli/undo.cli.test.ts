import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/core/index.js', () => ({
  getLastBackup: vi.fn(),
  restoreBackup: vi.fn(),
  saveState: vi.fn(),
  loadState: vi.fn().mockReturnValue({ currentMode: 'npm' }),
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
    validationError: vi.fn(() => ({ ok: false, error: { code: 'KB_RUNTIME_INPUT_INVALID', message: 'No backups found.', hint: 'Run switch first to create a backup.' } })),
  };
});

import { getLastBackup, restoreBackup, saveState, loadState } from '../../../src/core/index.js';
import { createCapturedUI, createMockContext, mockCLIInput } from '@kb-labs/sdk/testing';
import undoCommand from '../../../src/cli/commands/undo.js';

interface UndoFlags {
  json?: boolean;
  'dry-run'?: boolean;
}

const mockBackup = {
  id: 'backup-abc123',
  timestamp: '2026-01-01T00:00:00Z',
  modeAtBackup: 'local',
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getLastBackup).mockReturnValue(mockBackup as never);
  vi.mocked(restoreBackup).mockReturnValue({ restored: 5, errors: [] } as never);
  vi.mocked(loadState).mockReturnValue({ currentMode: 'npm' } as never);
  vi.mocked(saveState).mockReturnValue(undefined);
});

describe('devlink:undo', () => {
  it('UNDO-01: restores from backup and prints success', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    const result = await undoCommand.execute(ctx as never, mockCLIInput<UndoFlags>());

    expect(result).toMatchObject({ restored: 5, backupId: 'backup-abc123', errors: [] });
    expect(restoreBackup).toHaveBeenCalledOnce();
    expect(captured.success.length).toBeGreaterThan(0);
  });

  it('UNDO-02: no backup exits 1', async () => {
    vi.mocked(getLastBackup).mockReturnValue(null as never);
    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    const result = await undoCommand.execute(ctx as never, mockCLIInput<UndoFlags>());

    expect(result).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_INPUT_INVALID', hint: 'Run switch first to create a backup.' } });
    expect(restoreBackup).not.toHaveBeenCalled();
  });

  it('UNDO-03: --json outputs structured result', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    const result = await undoCommand.execute(ctx as never, mockCLIInput<UndoFlags>({ flags: { json: true } }));

    expect(result).toMatchObject({ backupId: 'backup-abc123' });
  });

  it('UNDO-04: --dry-run shows intent, restoreBackup is NOT called', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    const result = await undoCommand.execute(ctx as never, mockCLIInput<UndoFlags>({ flags: { 'dry-run': true } }));

    expect(result).toMatchObject({ summary: expect.stringContaining('Restore previous dependency state'), operations: expect.any(Array) });
    expect(restoreBackup).not.toHaveBeenCalled();
    expect(captured.infos[0]?.message).toContain('Dry-run');
  });
});
