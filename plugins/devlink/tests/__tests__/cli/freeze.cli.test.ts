import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/core/index.js', () => ({
  discoverMonorepos: vi.fn().mockReturnValue([]),
  buildPackageMapFiltered: vi.fn().mockResolvedValue({}),
  buildPlan: vi.fn().mockReturnValue({ mode: 'npm', items: [] }),
  freeze: vi.fn().mockReturnValue({ frozenAt: '2026-01-01T00:00:00Z', plan: { mode: 'npm' } }),
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
  };
});

import { discoverMonorepos, buildPackageMapFiltered, buildPlan, freeze, loadState } from '../../../src/core/index.js';
import { createCapturedUI, createMockContext, mockCLIInput } from '@kb-labs/sdk/testing';
import freezeCommand from '../../../src/cli/commands/freeze.js';

interface FreezeFlags {
  json?: boolean;
  'dry-run'?: boolean;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(discoverMonorepos).mockReturnValue([]);
  vi.mocked(buildPackageMapFiltered).mockResolvedValue({});
  vi.mocked(buildPlan).mockReturnValue({ mode: 'npm', items: [] } as never);
  vi.mocked(freeze).mockReturnValue({ frozenAt: '2026-01-01T00:00:00Z', plan: { mode: 'npm' } } as never);
  vi.mocked(loadState).mockReturnValue({ currentMode: 'npm' } as never);
});

describe('devlink:freeze', () => {
  it('FREEZE-01: freezes state and prints success', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    const result = await freezeCommand.execute(ctx as never, mockCLIInput<FreezeFlags>());

    expect(result).toMatchObject({ frozenAt: '2026-01-01T00:00:00Z', plan: { mode: 'npm' } });
    expect(freeze).toHaveBeenCalledOnce();
    expect(captured.success.length).toBeGreaterThan(0);
  });

  it('FREEZE-02: --json outputs lock data', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    const result = await freezeCommand.execute(ctx as never, mockCLIInput<FreezeFlags>({ flags: { json: true } }));

    expect(result).toMatchObject({ frozenAt: expect.any(String) });
  });

  it('FREEZE-03: --dry-run shows intent, freeze is NOT called', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    const result = await freezeCommand.execute(ctx as never, mockCLIInput<FreezeFlags>({ flags: { 'dry-run': true } }));

    expect(result).toMatchObject({ summary: expect.stringContaining('Freeze current dependency state'), operations: expect.any(Array) });
    expect(freeze).not.toHaveBeenCalled();
    expect(captured.infos[0]?.message).toContain('Dry-run');
  });
});
