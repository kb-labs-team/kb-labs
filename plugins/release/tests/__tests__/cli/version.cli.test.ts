import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/core/index.js', () => ({
  planRelease: vi.fn(),
  updatePackageVersions: vi.fn(),
  resolveScopePath: vi.fn((_root: string, scope: string) => `${_root}/${scope}`),
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

vi.mock('../../../src/shared/utils.js', () => ({
  findRepoRoot: vi.fn().mockResolvedValue('/project'),
}));

import { planRelease, updatePackageVersions } from '../../../src/core/index.js';
import { createCapturedUI, createMockContext, mockCLIInput } from '@kb-labs/sdk/testing';
import versionCommand from '../../../src/cli/commands/version.js';

const mockPlan = {
  packages: [
    { name: '@kb-labs/sdk', currentVersion: '1.0.0', nextVersion: '1.1.0' },
    { name: '@kb-labs/core', currentVersion: '2.0.0', nextVersion: '2.1.0' },
  ],
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(planRelease).mockResolvedValue(mockPlan as never);
  vi.mocked(updatePackageVersions).mockResolvedValue([
    { package: '@kb-labs/sdk', from: '1.0.0', to: '1.1.0', updated: true },
    { package: '@kb-labs/core', from: '2.0.0', to: '2.1.0', updated: true },
  ] as never);
});

describe('release:version', () => {
  it('VB-01: bumps versions — exitCode 0, success shown', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    const result = await versionCommand.execute(ctx as never, mockCLIInput({ flags: {} }));

    expect(result).toMatchObject({ ok: true });
    expect(vi.mocked(updatePackageVersions)).toHaveBeenCalledOnce();
  });

  it('VB-02: no packages found — exitCode 0, message shown', async () => {
    vi.mocked(planRelease).mockResolvedValue({ packages: [] } as never);

    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    const result = await versionCommand.execute(ctx as never, mockCLIInput({ flags: {} }));

    expect(result).toMatchObject({ ok: true });
    expect(vi.mocked(updatePackageVersions)).not.toHaveBeenCalled();
  });

  it('VB-03: --json outputs updates array', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    const result = await versionCommand.execute(ctx as never, mockCLIInput({ flags: { json: true } }));

    expect(result).toMatchObject({ ok: true, updates: expect.any(Array) });
    expect(result).not.toHaveProperty('result');
  });

  it('VB-04: --dry-run shows intent, updatePackageVersions is NOT called', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    const result = await versionCommand.execute(ctx as never, mockCLIInput({ flags: { 'dry-run': true } }));

    expect(result).toMatchObject({ summary: expect.stringContaining('2 package(s)'), operations: expect.any(Array) });
    expect(vi.mocked(updatePackageVersions)).not.toHaveBeenCalled();
    expect(captured.infos[0]?.message).toContain('Dry-run');
    expect(captured.infos[0]?.message).toContain('2 package');
  });

  it('VB-05: reports failed updates as the same typed failure in human and JSON modes', async () => {
    vi.mocked(updatePackageVersions).mockResolvedValue([
      { package: '@kb-labs/sdk', from: '1.0.0', to: '1.1.0', updated: false },
    ] as never);

    const jsonContext = createMockContext({ ui: createCapturedUI().ui, cwd: '/project' });
    const textContext = createMockContext({ ui: createCapturedUI().ui, cwd: '/project' });
    const jsonResult = await versionCommand.execute(jsonContext as never, mockCLIInput({ flags: { json: true } }));
    const textResult = await versionCommand.execute(textContext as never, mockCLIInput({ flags: {} }));

    expect(jsonResult).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_COMMAND_FAILED' } });
    expect(jsonResult).toEqual(textResult);
  });
});
