import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorktreeWorkspaceAdapter } from './index.js';

const roots: string[] = [];

async function makeRepository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'worktree-patch-owner-'));
  roots.push(root);
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'patch@example.test']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Patch Test']);
  await writeFile(path.join(root, 'tracked.txt'), 'before\n');
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'base']);
  return realpath(root);
}

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function adapter(): WorktreeWorkspaceAdapter {
  return new WorktreeWorkspaceAdapter({ toolDistPaths: [], initSubmodules: false, installDeps: false });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('workspace patch ownership', () => {
  // case: S-325.4
  it('recovers only the exact project, workspace, and owner run after restart', async () => {
    const projectRoot = await makeRepository();
    const workspaceId = 'wt_owner_test';
    const workspaceRoot = path.join(projectRoot, '.worktrees', workspaceId);
    const originalAdapter = adapter();
    await originalAdapter.materialize({ workspaceId, projectRoot, ownerRunId: 'run_owner_123' });
    await writeFile(path.join(workspaceRoot, 'tracked.txt'), 'changed after restart\n');

    const restartedAdapter = adapter();
    const exported = await restartedAdapter.exportPatch({
      workspaceId,
      projectRoot,
      ownerRunId: 'run_owner_123',
      workspaceRoot,
    });
    const patch = await collect(exported.patch);
    expect(patch.toString()).toContain('changed after restart');
    await expect(restartedAdapter.exportPatch({
      workspaceId,
      projectRoot,
      ownerRunId: 'run_other_456',
      workspaceRoot,
    })).rejects.toMatchObject({ code: 'KB_WORKSPACE_PATCH_OWNER_UNVERIFIED' });
    await expect(restartedAdapter.exportPatch({
      workspaceId: 'wt_someone_else',
      projectRoot,
      ownerRunId: 'run_owner_123',
      workspaceRoot,
    })).rejects.toMatchObject({ code: 'KB_WORKSPACE_PATCH_ROOT_MISMATCH' });
  });

  // case: S-325.4
  it('rejects a workspace path supplied from another project', async () => {
    const projectRoot = await makeRepository();
    const otherProjectRoot = await makeRepository();
    const workspaceId = 'wt_cross_project';
    const workspaceRoot = path.join(projectRoot, '.worktrees', workspaceId);
    await adapter().materialize({ workspaceId, projectRoot, ownerRunId: 'run_project_a' });

    await expect(adapter().exportPatch({
      workspaceId,
      projectRoot: otherProjectRoot,
      ownerRunId: 'run_project_a',
      workspaceRoot,
    })).rejects.toMatchObject({ code: 'KB_WORKSPACE_PATCH_ROOT_MISMATCH' });
  });

  // case: S-325.4
  it('keeps a legacy worktree without owner proof available for manual recovery', async () => {
    const projectRoot = await makeRepository();
    const workspaceId = 'wt_legacy_owner';
    const workspaceRoot = path.join(projectRoot, '.worktrees', workspaceId);
    await adapter().materialize({ workspaceId, projectRoot, ownerRunId: 'run_legacy_123' });
    const gitDir = execFileSync('git', ['-C', workspaceRoot, 'rev-parse', '--git-dir'], { encoding: 'utf8' }).trim();
    const gitMetadata = path.resolve(workspaceRoot, gitDir);
    await Promise.all([
      unlink(path.join(gitMetadata, 'kb-workflow-owner-run')),
      unlink(path.join(gitMetadata, 'kb-workflow-base')),
    ]);

    const restartedAdapter = adapter();
    await expect(restartedAdapter.materialize({ workspaceId, projectRoot, ownerRunId: 'run_legacy_123' }))
      .resolves.toMatchObject({ status: 'ready', rootPath: workspaceRoot });
    await expect(restartedAdapter.exportPatch({
      workspaceId,
      projectRoot,
      ownerRunId: 'run_legacy_123',
      workspaceRoot,
    })).rejects.toMatchObject({ code: 'KB_WORKSPACE_PATCH_OWNER_UNVERIFIED' });
    await expect(readFile(path.join(workspaceRoot, 'tracked.txt'), 'utf8')).resolves.toBe('before\n');
    await expect(restartedAdapter.startupCleanup(projectRoot)).resolves.toEqual([
      expect.objectContaining({ workspaceId, status: 'preserved', path: workspaceRoot }),
    ]);
  });
});
