import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/core/index.js', () => ({
  verifyCleanInstall: vi.fn(),
}));

import { verifyCleanInstall } from '../../../src/core/index.js';
import { createCapturedUI, createMockContext, mockCLIInput } from '@kb-labs/sdk/testing';
import verifyCleanInstallCommand from '../../../src/cli/commands/verify-clean-install.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('release:clean-install', () => {
  it('VCI-01: ok:true when verifyCleanInstall succeeds', async () => {
    vi.mocked(verifyCleanInstall).mockResolvedValue({ ok: true });
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    const result = await verifyCleanInstallCommand.execute(
      ctx as never,
      mockCLIInput({ flags: { tarball: '/tmp/pkg.tgz', name: '@kb-labs/sdk' } }),
    );

    expect(result).toMatchObject({ ok: true });
    expect(vi.mocked(verifyCleanInstall)).toHaveBeenCalledWith('/tmp/pkg.tgz', '@kb-labs/sdk', [], 'npm', undefined);
  });

  it('VCI-05: passes --registry through to verifyCleanInstall', async () => {
    vi.mocked(verifyCleanInstall).mockResolvedValue({ ok: true });
    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    await verifyCleanInstallCommand.execute(
      ctx as never,
      mockCLIInput({ flags: { tarball: '/tmp/pkg.tgz', name: '@kb-labs/sdk', registry: 'http://localhost:4873' } }),
    );

    expect(vi.mocked(verifyCleanInstall)).toHaveBeenCalledWith('/tmp/pkg.tgz', '@kb-labs/sdk', [], 'npm', 'http://localhost:4873');
  });

  it('VCI-02: ok:false with the real reason surfaced when verifyCleanInstall fails', async () => {
    vi.mocked(verifyCleanInstall).mockResolvedValue({
      ok: false,
      error: 'install failed: [EUNSUPPORTEDPROTOCOL] Unsupported URL Type "workspace:": workspace:*',
    });
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    const result = await verifyCleanInstallCommand.execute(
      ctx as never,
      mockCLIInput({ flags: { tarball: '/tmp/pkg.tgz', name: '@kb-labs/sdk' } }),
    );

    expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining('EUNSUPPORTEDPROTOCOL') } });
    expect(result).toMatchObject({ error: { message: expect.stringContaining('workspace:*') } });
  });

  it('VCI-03: missing --tarball or --name fails before calling verifyCleanInstall', async () => {
    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    const result = await verifyCleanInstallCommand.execute(ctx as never, mockCLIInput({ flags: {} }));

    expect(result).toMatchObject({ ok: false });
    expect(vi.mocked(verifyCleanInstall)).not.toHaveBeenCalled();
  });

  it('VCI-04: --json outputs the CleanInstallResult', async () => {
    vi.mocked(verifyCleanInstall).mockResolvedValue({ ok: true });
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui, cwd: '/project' });

    const result = await verifyCleanInstallCommand.execute(
      ctx as never,
      mockCLIInput({ flags: { tarball: '/tmp/pkg.tgz', name: '@kb-labs/sdk', json: true } }),
    );

    expect(result).toMatchObject({ ok: true });
    expect(result).not.toHaveProperty('result');
  });
});
