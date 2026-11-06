import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/core/index.js', () => ({
  DevkitAdapter: vi.fn().mockImplementation(function DevkitAdapterMock() {
    return {
      check: vi.fn().mockResolvedValue({ passed: 10, failed: 0, skipped: 0 }),
      stats: vi.fn().mockResolvedValue({ coverage: 85, duration: 1200 }),
    };
  }),
  SnapshotStore: vi.fn().mockImplementation(function SnapshotStoreMock() {
    return {
      saveBaseline: vi.fn().mockReturnValue({ id: 'baseline-1', createdAt: '2026-01-01' }),
    };
  }),
  resolveDevkitBin: vi.fn().mockReturnValue('/usr/local/bin/kb-devkit'),
  captureGit: vi.fn().mockResolvedValue({ commit: 'abc123', branch: 'main', message: 'test' }),
  buildBaselineReport: vi.fn().mockReturnValue([{ header: 'Results', lines: ['✓ Baseline saved'] }]),
}));

vi.mock('@kb-labs/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kb-labs/sdk')>();
  return {
    ...actual,
    useConfig: vi.fn().mockResolvedValue(null),
  };
});

import { DevkitAdapter, SnapshotStore, resolveDevkitBin, captureGit, buildBaselineReport } from '../../../src/core/index.js';
import { createCapturedUI, createMockContext, mockCLIInput } from '@kb-labs/sdk/testing';
import baselineUpdateCommand from '../../../src/cli/commands/baseline-update.js';
import type { BaselineUpdateFlags } from '../../../src/cli/commands/flags.js';

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(resolveDevkitBin).mockReturnValue('/usr/local/bin/kb-devkit');
  vi.mocked(captureGit).mockResolvedValue({ commit: 'abc123', branch: 'main', message: 'test' } as never);
  vi.mocked(buildBaselineReport).mockReturnValue([{ header: 'Results', lines: ['✓ Baseline saved'] }]);
  vi.mocked(DevkitAdapter).mockImplementation(function DevkitAdapterImplementation() {
    return {
      check: vi.fn().mockResolvedValue({ passed: 10, failed: 0, skipped: 0 }),
      stats: vi.fn().mockResolvedValue({ coverage: 85, duration: 1200 }),
    } as never;
  });
  vi.mocked(SnapshotStore).mockImplementation(function SnapshotStoreImplementation() {
    return {
      saveBaseline: vi.fn().mockReturnValue({ id: 'baseline-1', createdAt: '2026-01-01' }),
    } as never;
  });
});

describe('qa:baseline:update', () => {
  it('QBU-01: runs check+stats and saves baseline', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    const result = await baselineUpdateCommand.execute(ctx as never, mockCLIInput<BaselineUpdateFlags>());

    expect(result).not.toHaveProperty('ok');
    expect(SnapshotStore).toHaveBeenCalledOnce();
    expect(captured.success.length).toBeGreaterThan(0);
  });

  it('QBU-02: --json outputs baseline data', async () => {
    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    const result = await baselineUpdateCommand.execute(ctx as never, mockCLIInput<BaselineUpdateFlags>({ flags: { json: true } }));

    expect(result).toMatchObject({ id: 'baseline-1' });
  });

  it('QBU-03: --dry-run shows intent, no checks run', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    const result = await baselineUpdateCommand.execute(ctx as never, mockCLIInput<BaselineUpdateFlags>({ flags: { 'dry-run': true } }));

    expect(result).not.toHaveProperty('ok');
    expect(DevkitAdapter).not.toHaveBeenCalled();
    expect(SnapshotStore).not.toHaveBeenCalled();
    expect(captured.infos[0]?.message).toContain('Dry-run');
  });
});
