import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { WorktreeWorkspaceAdapter } from './index.js';

let root: string;
function adapter() {
  return new WorktreeWorkspaceAdapter({
    workspace: { projectRoot: root }, toolDistPaths: [], initSubmodules: false, installDeps: false,
  });
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'kb-worktree-restart-')));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root });
  git('init', '-q');
  writeFileSync(path.join(root, '.gitignore'), '*.local\n');
  git('add', '.gitignore');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'fixture');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

// case: S-198.8
it('preserves active, dirty and ignored-only working copies across adapter restarts', async () => {
  const live = adapter();
  const worktree = (id: string) => path.join(root, '.worktrees', id);
  for (const workspaceId of ['active', 'ignored', 'dirty']) {
    await live.materialize({ workspaceId, sourceRef: 'HEAD' });
  }
  writeFileSync(path.join(worktree('ignored'), 'handwritten.local'), 'unpublished');
  writeFileSync(path.join(worktree('dirty'), '.gitignore'), '*.scratch\n');
  writeFileSync(path.join(worktree('dirty'), 'draft'), 'draft');

  const results = await adapter().startupCleanup();
  expect(results).toEqual(expect.arrayContaining(['active', 'ignored', 'dirty'].map(workspaceId =>
    expect.objectContaining({ workspaceId, path: worktree(workspaceId), status: 'preserved' }))));
  expect(readFileSync(path.join(worktree('ignored'), 'handwritten.local'), 'utf8')).toBe('unpublished');
  expect(readFileSync(path.join(worktree('dirty'), 'draft'), 'utf8')).toBe('draft');
  expect(readFileSync(path.join(worktree('dirty'), '.gitignore'), 'utf8')).toBe('*.scratch\n');
  expect((await live.getStatus('active')).status).toBe('ready');
});

// case: S-198.8
it('keeps the clean worktree when provisioning fails after git add', async () => {
  const workspaceId = 'provisioning';
  await expect(adapter().materialize({
    workspaceId, sourceRef: 'HEAD', onProgress(event) {
      if (event.progress === 25) {
        throw new Error('interrupted');
      }
    },
  })).rejects.toThrow(/preserved for recovery/);
  expect(readFileSync(path.join(root, '.worktrees', workspaceId, '.gitignore'), 'utf8')).toBe('*.local\n');
});
