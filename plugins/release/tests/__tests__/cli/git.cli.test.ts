import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/core/index.js', () => ({
  planRelease: vi.fn(),
  commitAndTagRelease: vi.fn(),
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

import { planRelease, commitAndTagRelease } from '../../../src/core/index.js';
import { useConfig } from '@kb-labs/sdk';
import { createCapturedUI, createMockContext, mockCLIInput } from '@kb-labs/sdk/testing';
import gitCommand from '../../../src/cli/commands/git.js';

const mockPlan = {
  packages: [
    { name: '@kb-labs/sdk', currentVersion: '1.0.0', nextVersion: '1.1.0' },
    { name: '@kb-labs/core', currentVersion: '2.0.0', nextVersion: '2.1.0' },
  ],
};

const mockGitResult = {
  committed: true,
  tagged: ['@kb-labs/sdk@1.1.0', '@kb-labs/core@2.1.0'],
  pushed: true,
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(planRelease).mockResolvedValue(mockPlan as never);
  vi.mocked(commitAndTagRelease).mockResolvedValue(mockGitResult as never);
});

describe('release:git', () => {
  it('GB-01: commits, tags, pushes — exitCode 0, commitAndTagRelease called', async () => {
    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    const result = await gitCommand.execute(ctx as never, mockCLIInput({ flags: {} }));

    expect(result).toMatchObject({ committed: true, pushed: true });
    expect(vi.mocked(commitAndTagRelease)).toHaveBeenCalledOnce();
  });

  it('GB-02: no packages found — exitCode 0, commitAndTagRelease NOT called', async () => {
    vi.mocked(planRelease).mockResolvedValue({ packages: [] } as never);

    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    const result = await gitCommand.execute(ctx as never, mockCLIInput({ flags: {} }));

    expect(result).toMatchObject({ committed: false, tagged: [], pushed: false });
    expect(vi.mocked(commitAndTagRelease)).not.toHaveBeenCalled();
  });

  it('GB-03: --json outputs committed/tagged/pushed', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    const result = await gitCommand.execute(ctx as never, mockCLIInput({ flags: { json: true } }));

    expect(result).not.toHaveProperty('result');
    expect(result).toMatchObject({ committed: true, tagged: expect.any(Array), pushed: true });
  });

  it('GB-05: --flow is forwarded to commitAndTagRelease as flowName + tagPattern (regression: tag defaulted to "release-vX" instead of "<flow>-vX")', async () => {
    vi.mocked(useConfig).mockResolvedValue({
      flows: { platform: { tagPattern: '{flow}-v{version}' } },
    } as never);

    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    await gitCommand.execute(ctx as never, mockCLIInput({ flags: { flow: 'platform' } }));

    expect(vi.mocked(commitAndTagRelease)).toHaveBeenCalledWith(
      expect.objectContaining({ flowName: 'platform', tagPattern: '{flow}-v{version}' }),
    );
  });

  it('GB-04: --dry-run shows intent, commitAndTagRelease is NOT called', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    const result = await gitCommand.execute(ctx as never, mockCLIInput({ flags: { 'dry-run': true } }));

    expect(result).toMatchObject({ summary: expect.stringContaining('2 package(s)'), operations: expect.any(Array) });
    expect(vi.mocked(commitAndTagRelease)).not.toHaveBeenCalled();
    expect(captured.infos[0]?.message).toContain('Dry-run');
    expect(captured.infos[0]?.message).toContain('2 package');
  });
});
