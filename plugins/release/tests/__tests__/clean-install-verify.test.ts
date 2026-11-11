import { describe, it, expect, vi, beforeEach } from 'vitest';

// Reproduces the "npm swallows the real error" incident: npm's own CLI
// catches EUNSUPPORTEDPROTOCOL (thrown deep inside its own Arborist
// dependency resolver, several levels into someone else's dependency graph)
// as an unhandled rejection and prints nothing beyond "npm error, see log
// file" — confirmed live chasing @kb-labs/sdk@2.115.0's install failure,
// which took a manual Arborist repro script to actually diagnose.
// verifyCleanInstall() calls Arborist directly so the real Error surfaces.

const mockReify = vi.fn();
const mockArboristCtor = vi.fn(class MockArborist {
  reify = mockReify;
});

vi.mock('@npmcli/arborist', () => ({
  Arborist: mockArboristCtor,
}));

vi.mock('node:fs', () => ({
  mkdtempSync: vi.fn(() => '/tmp/kb-clean-install-fake'),
  rmSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn((command: string, args: string[]) => ({
    status: 0,
    stdout: command === 'tar' && args[0] === 'xOf' ? JSON.stringify({ name: args[1] === '/tmp/pkg.tgz' ? '@kb-labs/sdk' : '@kb-labs/peer' }) : '',
    stderr: '',
  })),
}));

import { spawnSync } from 'node:child_process';
import { verifyCleanInstall } from '../../src/core/clean-install-verify.js';

beforeEach(() => {
  vi.clearAllMocks();
  mockReify.mockResolvedValue(undefined);
  vi.mocked(spawnSync).mockImplementation((command: string, args?: readonly string[]) => ({
    status: 0,
    stdout: command === 'tar' && args?.[0] === 'xOf'
      ? Buffer.from(JSON.stringify({ name: args?.[1] === '/tmp/pkg.tgz' ? '@kb-labs/sdk' : '@kb-labs/peer' }))
      : Buffer.from(''),
    stderr: Buffer.from(''),
    pid: 1,
    output: [],
    signal: null,
  }) as never);
});

describe('verifyCleanInstall', () => {
  it('reports ok:true when install and import both succeed', async () => {
    const result = await verifyCleanInstall('/tmp/pkg.tgz', '@kb-labs/sdk');

    expect(result.ok).toBe(true);
    expect(mockReify).toHaveBeenCalledWith(expect.objectContaining({ add: ['/tmp/pkg.tgz'] }));
  });

  it('uses pnpm for the configured pnpm path and keeps the staged tarballs in the install set', async () => {
    const result = await verifyCleanInstall('/tmp/pkg.tgz', '@kb-labs/sdk', ['/tmp/peer.tgz'], 'pnpm');

    expect(result.ok).toBe(true);
    expect(vi.mocked(spawnSync)).toHaveBeenCalledWith(
      'pnpm',
      ['install', '--ignore-scripts', '--no-lockfile', '--config.auto-install-peers=true'],
      expect.objectContaining({ cwd: '/tmp/kb-clean-install-fake' }),
    );
    expect(mockReify).not.toHaveBeenCalled();
  });

  it('surfaces the real Arborist error message and code on install failure, instead of npm\'s swallowed "see log file"', async () => {
    const err = new Error('Unsupported URL Type "workspace:": workspace:*') as NodeJS.ErrnoException;
    err.code = 'EUNSUPPORTEDPROTOCOL';
    mockReify.mockRejectedValue(err);

    const result = await verifyCleanInstall('/tmp/pkg.tgz', '@kb-labs/sdk');

    expect(result.ok).toBe(false);
    expect(result.error).toContain('EUNSUPPORTEDPROTOCOL');
    expect(result.error).toContain('workspace:*');
  });

  it('passes registry through to Arborist for the npm path', async () => {
    const result = await verifyCleanInstall('/tmp/pkg.tgz', '@kb-labs/sdk', [], 'npm', 'http://localhost:4873');

    expect(result.ok).toBe(true);
    expect(mockArboristCtor).toHaveBeenCalledWith(
      expect.objectContaining({ registry: 'http://localhost:4873' }),
    );
  });

  // Arborist's reify() unconditionally submits a bulk security-advisory
  // request and awaits it before returning (unless constructed with
  // audit:false) — a real network round-trip this call site never reads
  // the result of (auditReport is never accessed below). Disabling it must
  // not change what the check actually verifies: a broken manifest still
  // fails via reify() rejecting, exercised by the EUNSUPPORTEDPROTOCOL test
  // above, which passes regardless of the audit flag.
  it('disables the Arborist audit network call, which this check never reads', async () => {
    const result = await verifyCleanInstall('/tmp/pkg.tgz', '@kb-labs/sdk');

    expect(result.ok).toBe(true);
    expect(mockArboristCtor).toHaveBeenCalledWith(
      expect.objectContaining({ audit: false }),
    );
  });

  it('writes a .npmrc registry override for the pnpm path', async () => {
    const fs = await import('node:fs');
    const result = await verifyCleanInstall('/tmp/pkg.tgz', '@kb-labs/sdk', [], 'pnpm', 'http://localhost:4873');

    expect(result.ok).toBe(true);
    expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
      '/tmp/kb-clean-install-fake/.npmrc',
      'registry=http://localhost:4873\n',
    );
  });

  it('reports ok:false when install succeeds but the import check fails', async () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 1,
      stdout: Buffer.from(''),
      stderr: Buffer.from('Cannot find module'),
      pid: 1,
      output: [],
      signal: null,
    });

    const result = await verifyCleanInstall('/tmp/pkg.tgz', '@kb-labs/sdk');

    expect(result.ok).toBe(false);
    expect(result.error).toContain('cannot import @kb-labs/sdk');
    expect(result.error).toContain('Cannot find module');
  });
});
