import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { WorktreeWorkspaceAdapter } from './index.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn(), mkdirSync: vi.fn(), readdirSync: vi.fn(), symlinkSync: vi.fn(), rmSync: vi.fn() };
});

// These unit cases use virtual project/platform roots. Real-path ownership
// checks against the filesystem are exercised by the integration fixtures.
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, realpath: vi.fn(async (file: string) => file) };
});

vi.mock('node:child_process', () => ({
  exec: vi.fn((_cmd: string, _opts: unknown, cb: (err: null, res: { stdout: string }) => void) =>
    cb(null, { stdout: '' })
  ),
  execFile: vi.fn((_file: string, args: string[], _opts: unknown, cb: (err: null, res: { stdout: string; stderr: string }) => void) => {
    const stdout = args.join(' ') === 'rev-parse HEAD'
      ? 'a'.repeat(40)
      : '';
    cb(null, { stdout, stderr: '' });
  }),
  spawn: vi.fn(),
}));

describe('WorktreeWorkspaceAdapter', () => {
  it('should export createAdapter factory', async () => {
    const { createAdapter } = await import('./index.js');
    expect(typeof createAdapter).toBe('function');
  });

  it('should create adapter with default config', () => {
    const adapter = new WorktreeWorkspaceAdapter();
    expect(adapter).toBeDefined();
    expect(typeof adapter.materialize).toBe('function');
    expect(typeof adapter.release).toBe('function');
    expect(typeof adapter.getStatus).toBe('function');
    expect(typeof adapter.getCapabilities).toBe('function');
  });

  it('should return capabilities', () => {
    const adapter = new WorktreeWorkspaceAdapter();
    const caps = adapter.getCapabilities();
    expect(caps.supportsAttach).toBe(true);
    expect(caps.supportsRelease).toBe(true);
  });

  it('should return released status for unknown workspace', async () => {
    const adapter = new WorktreeWorkspaceAdapter();
    const status = await adapter.getStatus('nonexistent');
    expect(status.status).toBe('released');
  });

  it('should reject invalid branch names', async () => {
    const adapter = new WorktreeWorkspaceAdapter();
    await expect(
      adapter.materialize({ sourceRef: 'main; rm -rf /' })
    ).rejects.toThrow('Invalid branch name');
  });

  describe('toolDistPaths config', () => {
    it('defaults to [cli/bin/dist]', () => {
      const adapter = new WorktreeWorkspaceAdapter();
      expect((adapter as unknown as Record<string, unknown>).toolDistPaths).toEqual(['cli/bin/dist']);
    });

    it('symlinkPlatformDist: false sets toolDistPaths to []', () => {
      const adapter = new WorktreeWorkspaceAdapter({ symlinkPlatformDist: false });
      expect((adapter as unknown as Record<string, unknown>).toolDistPaths).toEqual([]);
    });

    it('explicit toolDistPaths overrides default', () => {
      const adapter = new WorktreeWorkspaceAdapter({ toolDistPaths: ['tools/foo/dist', 'tools/bar/dist'] });
      expect((adapter as unknown as Record<string, unknown>).toolDistPaths).toEqual(['tools/foo/dist', 'tools/bar/dist']);
    });

    it('toolDistPaths: [] disables all symlinking', () => {
      const adapter = new WorktreeWorkspaceAdapter({ toolDistPaths: [] });
      expect((adapter as unknown as Record<string, unknown>).toolDistPaths).toEqual([]);
    });
  });

  // case: S-198.6
  it('uses explicit owning project and platform roots for materialization', async () => {
    const projectRoot = '/consumer/repository';
    const platformRoot = '/opt/kb-platform';
    const worktreePath = `${projectRoot}/.worktrees/wt_explicit`;
    vi.mocked(existsSync).mockImplementation((p) => {
      if (String(p) === `${projectRoot}/.worktrees`) return true;
      if (String(p) === worktreePath) return false;
      if (String(p) === `${platformRoot}/cli/bin/dist`) return true;
      if (String(p) === `${worktreePath}/cli/bin/dist`) return false;
      return false;
    });
    const adapter = new WorktreeWorkspaceAdapter({ initSubmodules: false, installDeps: false });

    await adapter.materialize({
      workspaceId: 'wt_explicit',
      sourceRef: 'main',
      projectRoot,
      platformRoot,
    }).catch(() => {});

    expect(vi.mocked(symlinkSync)).toHaveBeenCalledWith(
      `${platformRoot}/cli/bin/dist`, `${worktreePath}/cli/bin/dist`, 'dir',
    );
  });

  describe('symlinkDistFromPlatform', () => {
    beforeEach(() => {
      vi.mocked(existsSync).mockReset();
      vi.mocked(mkdirSync).mockReset();
      vi.mocked(symlinkSync).mockReset();
    });

    afterEach(() => {
      vi.mocked(existsSync).mockReset();
    });

    it('symlinks cli/bin/dist from platform into worktree by default', async () => {
      const repoRoot = '/platform';
      // worktreeBaseDir = repoRoot + '/.worktrees', worktreePath = worktreeBaseDir + '/' + workspaceId
      const worktreePath = `${repoRoot}/.worktrees/wt_test`;

      vi.mocked(existsSync).mockImplementation((p) => {
        if (String(p) === `${repoRoot}/.worktrees`) return true;
        if (String(p) === worktreePath) return false; // not reused
        if (String(p) === `${repoRoot}/cli/bin/dist`) return true;
        if (String(p) === `${worktreePath}/cli/bin/dist`) return false;
        return false;
      });

      const adapter = new WorktreeWorkspaceAdapter({
        workspace: { projectRoot: repoRoot, platformRoot: repoRoot },
        initSubmodules: false,
        installDeps: false,
      });

      await adapter.materialize({ workspaceId: 'wt_test', sourceRef: 'main' }).catch(() => {
        // git worktree add will fail in test — that's fine, we only care about symlink calls
      });

      const calls = vi.mocked(symlinkSync).mock.calls;
      const cliDistCall = calls.find(([src]) => String(src).endsWith('cli/bin/dist'));
      expect(cliDistCall).toBeDefined();
      expect(String(cliDistCall![0])).toBe(`${repoRoot}/cli/bin/dist`);
      expect(String(cliDistCall![1])).toBe(`${worktreePath}/cli/bin/dist`);
    });

    it('skips symlinking when toolDistPaths is empty', async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const adapter = new WorktreeWorkspaceAdapter({
        toolDistPaths: [],
        initSubmodules: false,
        installDeps: false,
      });

      await adapter.materialize({ workspaceId: 'wt_empty', sourceRef: 'main' }).catch(() => {});

      expect(vi.mocked(symlinkSync)).not.toHaveBeenCalled();
    });

    it('skips symlink when platform dist does not exist', async () => {
      const repoRoot = '/platform';
      const worktreePath = '/worktrees/wt_nodist';

      vi.mocked(existsSync).mockImplementation((p) => {
        if (String(p) === '/platform/.worktrees') return true;
        if (String(p) === worktreePath) return false;
        if (String(p) === `${repoRoot}/cli/bin/dist`) return false; // not built
        return false;
      });

      const adapter = new WorktreeWorkspaceAdapter({
        workspace: { projectRoot: repoRoot, platformRoot: repoRoot },
        initSubmodules: false,
        installDeps: false,
      });

      await adapter.materialize({ workspaceId: 'wt_nodist', sourceRef: 'main' }).catch(() => {});

      expect(vi.mocked(symlinkSync)).not.toHaveBeenCalled();
    });

    it('skips symlink when worktree dist already exists', async () => {
      const repoRoot = '/platform';
      const worktreePath = `${repoRoot}/.worktrees/wt_exists`;

      vi.mocked(existsSync).mockImplementation((p) => {
        if (String(p) === `${repoRoot}/.worktrees`) return true;
        if (String(p) === worktreePath) return false;
        if (String(p) === `${repoRoot}/cli/bin/dist`) return true;
        if (String(p) === `${worktreePath}/cli/bin/dist`) return true; // already there
        return false;
      });

      const adapter = new WorktreeWorkspaceAdapter({
        workspace: { projectRoot: repoRoot, platformRoot: repoRoot },
        initSubmodules: false,
        installDeps: false,
      });

      await adapter.materialize({ workspaceId: 'wt_exists', sourceRef: 'main' }).catch(() => {});

      expect(vi.mocked(symlinkSync)).not.toHaveBeenCalled();
    });
  });

  describe('symlinkEnvFromRoot', () => {
    beforeEach(() => {
      vi.mocked(existsSync).mockReset();
      vi.mocked(mkdirSync).mockReset();
      vi.mocked(symlinkSync).mockReset();
    });

    afterEach(() => {
      vi.mocked(existsSync).mockReset();
    });

    it('symlinks root .env into worktree when present and not already linked', async () => {
      const repoRoot = '/platform';
      const worktreePath = `${repoRoot}/.worktrees/wt_env`;

      vi.mocked(existsSync).mockImplementation((p) => {
        if (String(p) === `${repoRoot}/.worktrees`) return true;
        if (String(p) === worktreePath) return false;
        if (String(p) === `${repoRoot}/.env`) return true;
        if (String(p) === `${worktreePath}/.env`) return false;
        return false;
      });

      const adapter = new WorktreeWorkspaceAdapter({
        workspace: { projectRoot: repoRoot, platformRoot: repoRoot },
        initSubmodules: false,
        installDeps: false,
        toolDistPaths: [],
      });

      await adapter.materialize({ workspaceId: 'wt_env', sourceRef: 'main' }).catch(() => {});

      const calls = vi.mocked(symlinkSync).mock.calls;
      const envCall = calls.find(([src]) => String(src).endsWith('.env'));
      expect(envCall).toBeDefined();
      expect(String(envCall![0])).toBe(`${repoRoot}/.env`);
      expect(String(envCall![1])).toBe(`${worktreePath}/.env`);
    });

    it('skips symlink when root .env does not exist', async () => {
      const repoRoot = '/platform';
      const worktreePath = `${repoRoot}/.worktrees/wt_noenv`;

      vi.mocked(existsSync).mockImplementation((p) => {
        if (String(p) === `${repoRoot}/.worktrees`) return true;
        if (String(p) === worktreePath) return false;
        if (String(p) === `${repoRoot}/.env`) return false;
        return false;
      });

      const adapter = new WorktreeWorkspaceAdapter({
        workspace: { projectRoot: repoRoot, platformRoot: repoRoot },
        initSubmodules: false,
        installDeps: false,
        toolDistPaths: [],
      });

      await adapter.materialize({ workspaceId: 'wt_noenv', sourceRef: 'main' }).catch(() => {});

      expect(vi.mocked(symlinkSync)).not.toHaveBeenCalled();
    });

    it('skips symlink when worktree .env already exists', async () => {
      const repoRoot = '/platform';
      const worktreePath = `${repoRoot}/.worktrees/wt_envexists`;

      vi.mocked(existsSync).mockImplementation((p) => {
        if (String(p) === `${repoRoot}/.worktrees`) return true;
        if (String(p) === worktreePath) return false;
        if (String(p) === `${repoRoot}/.env`) return true;
        if (String(p) === `${worktreePath}/.env`) return true;
        return false;
      });

      const adapter = new WorktreeWorkspaceAdapter({
        workspace: { projectRoot: repoRoot, platformRoot: repoRoot },
        initSubmodules: false,
        installDeps: false,
        toolDistPaths: [],
      });

      await adapter.materialize({ workspaceId: 'wt_envexists', sourceRef: 'main' }).catch(() => {});

      expect(vi.mocked(symlinkSync)).not.toHaveBeenCalled();
    });
  });
});
