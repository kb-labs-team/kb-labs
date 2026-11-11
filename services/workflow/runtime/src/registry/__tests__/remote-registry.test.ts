/**
 * Tests for RemoteWorkflowRegistry — focused on shell injection safety (H8).
 * Verifies that git commands use execa with args array (no shell interpolation).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue(''),
  rm: vi.fn().mockResolvedValue(undefined),
  access: vi.fn().mockRejectedValue(new Error('not found')),
}));

vi.mock('fast-glob', () => ({ default: vi.fn().mockResolvedValue([]) }));

vi.mock('execa', () => ({
  execa: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}));

import * as fsp from 'node:fs/promises';
import * as execaModule from 'execa';
import { RemoteWorkflowRegistry } from '../remote-registry.js';

const mockExeca = vi.mocked(execaModule.execa);
const mockAccess = vi.mocked(fsp.access);

function makeRegistry(overrides?: { ref?: string; url?: string }) {
  return new RemoteWorkflowRegistry({
    workspaceRoot: '/workspace',
    remotes: [
      {
        name: 'my-remote',
        url: overrides?.url ?? 'https://github.com/org/workflows.git',
        ref: overrides?.ref,
      },
    ],
    cacheDir: '/tmp/kb-cache',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAccess.mockRejectedValue(new Error('not found'));
  mockExeca.mockResolvedValue({ stdout: '', stderr: '' } as any);
});

// ─── Shell injection safety ────────────────────────────────────────────────────

describe('RemoteWorkflowRegistry — shell injection safety (H8)', () => {
  it('passes git clone args as array, not interpolated shell string', async () => {
    const registry = makeRegistry({ ref: 'main' });
    await registry.list();

    expect(mockExeca).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['clone', '--depth', '1', '--branch', 'main']),
    );

    const [cmd, args, opts] = mockExeca.mock.calls[0] as unknown as [string, string[], Record<string, unknown>?];
    expect(typeof cmd).toBe('string');
    expect(Array.isArray(args)).toBe(true);
    expect((opts as Record<string, unknown> | undefined)?.shell).toBeFalsy();
  });

  it('ref with shell metacharacters is passed as a literal argument', async () => {
    const evilRef = 'main; rm -rf /';
    const registry = makeRegistry({ ref: evilRef });
    await registry.list();

    const [, args] = mockExeca.mock.calls[0]!;
    expect(args).toContain(evilRef);
  });

  it('url with shell metacharacters is passed as a literal argument', async () => {
    const evilUrl = 'https://example.com/repo.git && id';
    const registry = makeRegistry({ url: evilUrl });
    await registry.list();

    const [, args] = mockExeca.mock.calls[0]!;
    expect(args).toContain(evilUrl);
  });

  it('uses "main" as default ref when not specified', async () => {
    const registry = makeRegistry({ ref: undefined });
    await registry.list();

    const [, args] = mockExeca.mock.calls[0]!;
    expect(args).toContain('main');
  });

  it('passes update commands as arg arrays when repo already cloned', async () => {
    // Simulate already-cloned state: access on .git dir succeeds
    mockAccess.mockResolvedValue(undefined);

    const registry = makeRegistry({ ref: 'v1.2.3' });
    await registry.list();

    const calls = mockExeca.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);

    const fetchCall = calls.find(([, a]) => Array.isArray(a) && (a as string[]).includes('fetch'));
    expect(fetchCall).toBeTruthy();
    expect(fetchCall![1]).toContain('v1.2.3');

    const checkoutCall = calls.find(([, a]) => Array.isArray(a) && (a as string[]).includes('checkout'));
    expect(checkoutCall).toBeTruthy();
    expect(checkoutCall![1]).toContain('v1.2.3');
  });
});
