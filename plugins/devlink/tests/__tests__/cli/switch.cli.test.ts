import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/core/index.js', () => ({
  discoverMonorepos: vi.fn().mockReturnValue([{ name: 'kb-labs-core', rootPath: '/project/kb-labs-core', packagePaths: [] }]),
  buildPackageMapFiltered: vi.fn().mockResolvedValue({ '@kb-labs/sdk': { name: '@kb-labs/sdk', path: '/project/sdk' } }),
  buildPlan: vi.fn().mockReturnValue({ mode: 'link', items: [{ monorepo: 'kb-labs-core', file: 'package.json' }] }),
  applyPlan: vi.fn().mockResolvedValue({ applied: 1, skipped: 0, errors: [] }),
  createBackup: vi.fn().mockReturnValue({ id: 'backup-001', timestamp: '2026-01-01T00:00:00Z' }),
  loadState: vi.fn().mockReturnValue({ currentMode: 'npm' }),
  saveState: vi.fn(),
  checkGitDirty: vi.fn().mockReturnValue([]),
  updateWorkspaceYamls: vi.fn().mockReturnValue([]),
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
      update: vi.fn(),
    })),
  };
});

import {
  applyPlan,
  createBackup,
  discoverMonorepos,
  buildPackageMapFiltered,
  buildPlan,
  loadState,
  checkGitDirty,
  updateWorkspaceYamls,
} from '../../../src/core/index.js';
import { createCapturedUI, createMockContext, mockCLIInput } from '@kb-labs/sdk/testing';
import switchCommand from '../../../src/cli/commands/switch.js';

const defaultMonorepos = [{ name: 'kb-labs-core', rootPath: '/project/kb-labs-core', packagePaths: [] }];
const defaultPackageMap = { '@kb-labs/sdk': { name: '@kb-labs/sdk', path: '/project/sdk' } };
const defaultPlan = { mode: 'link' as const, items: [{ monorepo: 'kb-labs-core', file: 'package.json' }] };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(discoverMonorepos).mockReturnValue(defaultMonorepos as never);
  vi.mocked(buildPackageMapFiltered).mockResolvedValue(defaultPackageMap as never);
  vi.mocked(buildPlan).mockReturnValue(defaultPlan as never);
  vi.mocked(loadState).mockReturnValue({ currentMode: 'npm' } as never);
  vi.mocked(checkGitDirty).mockReturnValue([] as never);
  vi.mocked(updateWorkspaceYamls).mockReturnValue([] as never);
  vi.mocked(applyPlan).mockResolvedValue({ applied: 1, skipped: 0, errors: [] } as never);
  vi.mocked(createBackup).mockReturnValue({ id: 'backup-001', timestamp: '2026-01-01T00:00:00Z' } as never);
});

describe('devlink:switch', () => {
  it('SW-01: switches mode — exitCode 0, success message', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    const result = await switchCommand.execute(ctx as never, mockCLIInput({ flags: { mode: 'local' } }));

    expect(result).not.toHaveProperty('ok');
    expect(captured.success.length).toBeGreaterThan(0);
    expect(vi.mocked(applyPlan)).toHaveBeenCalledOnce();
  });

  it('SW-02: no changes needed — exitCode 0, info shown', async () => {
    const { buildPlan } = await import('../../../src/core/index.js');
    vi.mocked(buildPlan).mockReturnValue({ mode: 'link', items: [] } as never);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    const result = await switchCommand.execute(ctx as never, mockCLIInput({ flags: { mode: 'local' } }));

    expect(result).toEqual({ mode: 'local', changed: 0 });
    expect(vi.mocked(applyPlan)).not.toHaveBeenCalled();
    expect(captured.infos.length).toBeGreaterThan(0);
  });

  it('SW-03: discovery fails — exitCode 1, error shown', async () => {
    const { discoverMonorepos } = await import('../../../src/core/index.js');
    vi.mocked(discoverMonorepos).mockImplementation(() => { throw new Error('discovery failed'); });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    const result = await switchCommand.execute(ctx as never, mockCLIInput({ flags: { mode: 'local' } }));

    expect(result).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^KB_/), message: expect.any(String), hint: expect.any(String) } });
  });

  it('SW-04: --dry-run shows intent, applyPlan is NOT called', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    const result = await switchCommand.execute(ctx as never, mockCLIInput({ flags: { mode: 'local', 'dry-run': true } }));

    expect(result).toMatchObject({ summary: expect.stringContaining('Switch'), operations: expect.any(Array) });
    expect(vi.mocked(applyPlan)).not.toHaveBeenCalled();
    expect(captured.infos[0]?.message).toContain('Dry-run');
    expect(captured.infos[0]?.message).toContain('local');
  });
});
