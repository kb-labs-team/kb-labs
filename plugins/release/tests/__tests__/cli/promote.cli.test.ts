import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/core/index.js', () => ({
  discoverCurrentPackages: vi.fn(),
  resolvePublishTag: vi.fn((_config: unknown, channel: string) => (channel === 'canary' ? 'canary' : 'latest')),
  resolvePublishRegistry: vi.fn(() => 'https://registry.npmjs.org'),
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
    useEnv: vi.fn(() => undefined),
  };
});

vi.mock('../../../src/shared/utils.js', () => ({
  findRepoRoot: vi.fn().mockResolvedValue('/project'),
}));

vi.mock('../../../src/shared/publish-programmatic.js', () => ({
  publishPackagesProgrammatic: vi.fn(),
}));

vi.mock('../../../src/shared/publish-with-otp.js', () => ({
  publishPackagesWithOTP: vi.fn(),
}));

import { discoverCurrentPackages } from '../../../src/core/index.js';
import { createCapturedUI, createMockContext, mockCLIInput } from '@kb-labs/sdk/testing';
import { publishPackagesProgrammatic } from '../../../src/shared/publish-programmatic.js';
import { publishPackagesWithOTP } from '../../../src/shared/publish-with-otp.js';
import promoteCommand from '../../../src/cli/commands/promote.js';

const mockDiscovered = [
  { name: '@kb-labs/sdk', currentVersion: '1.1.0', nextVersion: '1.1.0', path: '/project/sdk', gitRoot: '/project', bump: 'auto', isPublished: false },
  { name: '@kb-labs/core', currentVersion: '2.1.0', nextVersion: '2.1.0', path: '/project/core', gitRoot: '/project', bump: 'auto', isPublished: false },
];

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(discoverCurrentPackages).mockResolvedValue(mockDiscovered as never);
  vi.mocked(publishPackagesWithOTP).mockResolvedValue({
    results: [
      { name: '@kb-labs/sdk', version: '1.1.0', success: true },
      { name: '@kb-labs/core', version: '2.1.0', success: true },
    ],
    published: ['@kb-labs/sdk@1.1.0', '@kb-labs/core@2.1.0'],
    alreadyPublished: [],
    failed: [],
    skipped: [],
    errors: [],
  } as never);
});

describe('release:promote', () => {
  it('PR-01: promotes CURRENT on-disk versions — never re-bumps or replans', async () => {
    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    const result = await promoteCommand.execute(ctx as never, mockCLIInput({ flags: {} }));

    expect(result).not.toHaveProperty('result');
    expect(vi.mocked(publishPackagesWithOTP)).toHaveBeenCalledOnce();
    const call = vi.mocked(publishPackagesWithOTP).mock.calls[0]![0] as { packages: Array<{ name: string; version: string }> };
    // Promoted at currentVersion, not some recomputed nextVersion.
    expect(call.packages).toEqual([
      { name: '@kb-labs/sdk', version: '1.1.0', path: '/project/sdk' },
      { name: '@kb-labs/core', version: '2.1.0', path: '/project/core' },
    ]);
  });

  it('PR-02: defaults tag to resolvePublishTag(config, "stable") = latest', async () => {
    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    await promoteCommand.execute(ctx as never, mockCLIInput({ flags: {} }));

    const call = vi.mocked(publishPackagesWithOTP).mock.calls[0]![0] as { tag?: string };
    expect(call.tag).toBe('latest');
  });

  it('PR-03: --tag overrides the config-resolved dist-tag', async () => {
    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    await promoteCommand.execute(ctx as never, mockCLIInput({ flags: { tag: 'next' } }));

    const call = vi.mocked(publishPackagesWithOTP).mock.calls[0]![0] as { tag?: string };
    expect(call.tag).toBe('next');
  });

  it('PR-04: no packages found — exitCode 1, publish never called', async () => {
    vi.mocked(discoverCurrentPackages).mockResolvedValue([] as never);

    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    const result = await promoteCommand.execute(ctx as never, mockCLIInput({ flags: {} }));

    expect(result).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_COMMAND_FAILED' } });
    expect(vi.mocked(publishPackagesWithOTP)).not.toHaveBeenCalled();
    expect(vi.mocked(publishPackagesProgrammatic)).not.toHaveBeenCalled();
  });

  it('PR-05: --json outputs promoted/failed summary', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    const result = await promoteCommand.execute(ctx as never, mockCLIInput({ flags: { json: true } }));

    expect(result).not.toHaveProperty('result');
    expect(result).toMatchObject({ summary: { total: 2, successful: 2, failed: 0, tag: 'latest' } });
  });
});
