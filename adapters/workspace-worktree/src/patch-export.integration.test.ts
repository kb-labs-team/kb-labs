import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorktreeWorkspaceAdapter } from './index.js';

const roots: string[] = [];

async function makeRepository(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'worktree-patch-export-')));
  roots.push(root);
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'patch@example.test']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Patch Test']);
  await writeFile(path.join(root, '.gitignore'), '.env\n');
  await writeFile(path.join(root, 'tracked.txt'), 'before\n');
  await writeFile(path.join(root, 'delete-me.txt'), 'delete me\n');
  await writeFile(path.join(root, 'script.sh'), '#!/bin/sh\necho before\n');
  await writeFile(path.join(root, 'image.bin'), Buffer.from([0, 1, 2]));
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'base']);
  return root;
}

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const ownerRunId = 'test-owner-run';

describe('WorktreeWorkspaceAdapter.exportPatch', () => {
  it('returns an empty patch when the worktree has no changes', async () => {
    const projectRoot = await makeRepository();
    const adapter = new WorktreeWorkspaceAdapter({ toolDistPaths: [], initSubmodules: false, installDeps: false });
    await adapter.materialize({ workspaceId: 'wt_empty_patch', sourceRef: 'HEAD', projectRoot, metadata: { runId: ownerRunId } });
    const exported = await adapter.exportPatch({ ownerRunId, workspaceId: 'wt_empty_patch', projectRoot, workspaceRoot: path.join(projectRoot, '.worktrees/wt_empty_patch') });
    expect(exported.changedFiles).toEqual([]);
    expect(await collect(exported.patch)).toEqual(Buffer.alloc(0));
  });

  it('exports a portable patch from the materialization base across agent commits and restart', async () => {
    const projectRoot = await makeRepository();
    const workspaceId = 'wt_patch_test';
    const workspaceRoot = path.join(projectRoot, '.worktrees', workspaceId);
    const config = { toolDistPaths: [], initSubmodules: false, installDeps: false };
    const adapter = new WorktreeWorkspaceAdapter(config);
    const materialized = await adapter.materialize({ workspaceId, sourceRef: 'HEAD', projectRoot, metadata: { runId: ownerRunId } });
    const baseCommit = execFileSync('git', ['-C', workspaceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

    await writeFile(path.join(workspaceRoot, 'tracked.txt'), 'agent committed this\n');
    execFileSync('git', ['-C', workspaceRoot, 'add', 'tracked.txt']);
    execFileSync('git', ['-C', workspaceRoot, 'commit', '-qm', 'agent commit']);
    await unlink(path.join(workspaceRoot, 'delete-me.txt'));
    await chmod(path.join(workspaceRoot, 'script.sh'), 0o755);
    await writeFile(path.join(workspaceRoot, 'image.bin'), Buffer.from([0, 255, 2, 128]));
    await writeFile(path.join(workspaceRoot, 'large.bin'), Buffer.alloc(1_100_000, 0x91));
    await writeFile(path.join(workspaceRoot, 'new.txt'), 'new file\n');
    await writeFile(path.join(workspaceRoot, '.env'), 'SECRET=not-for-patch\n');
    const objectCountBefore = execFileSync('git', ['-C', projectRoot, 'count-objects', '-v'], { encoding: 'utf8' });

    // A fresh adapter simulates daemon restart; the immutable base lives in the linked worktree gitdir.
    const restartedAdapter = new WorktreeWorkspaceAdapter(config);
    const exported = await restartedAdapter.exportPatch({ ownerRunId, workspaceId, projectRoot, workspaceRoot });
    const patch = await collect(exported.patch);
    const patchText = patch.toString('latin1');

    expect(exported.baseCommit).toBe(baseCommit);
    expect(exported.changedFiles).toEqual(['delete-me.txt', 'image.bin', 'large.bin', 'new.txt', 'script.sh', 'tracked.txt']);
    expect(patchText).toContain('GIT binary patch');
    expect(patchText).toContain('new file mode 100644');
    expect(patchText).toContain('deleted file mode 100644');
    expect(patchText).toContain('old mode 100644');
    expect(patchText).toContain('new mode 100755');
    expect(patchText).not.toContain('SECRET=not-for-patch');
    expect(execFileSync('git', ['-C', projectRoot, 'count-objects', '-v'], { encoding: 'utf8' })).toBe(objectCountBefore);

    const applyRoot = path.join(projectRoot, 'apply-checkout');
    execFileSync('git', ['clone', '-q', projectRoot, applyRoot]);
    execFileSync('git', ['-C', applyRoot, 'apply', '--check'], { input: patch });
    execFileSync('git', ['-C', applyRoot, 'apply'], { input: patch });
    expect(await readFile(path.join(applyRoot, 'tracked.txt'), 'utf8')).toBe('agent committed this\n');
    expect(await readFile(path.join(applyRoot, 'image.bin'))).toEqual(Buffer.from([0, 255, 2, 128]));
    expect(await readFile(path.join(applyRoot, 'large.bin'))).toEqual(Buffer.alloc(1_100_000, 0x91));
    expect(await readFile(path.join(applyRoot, 'script.sh')).then((value) => value.toString())).toContain('echo before');
    await expect(readFile(path.join(applyRoot, 'delete-me.txt'))).rejects.toThrow();
    expect(materialized.rootPath).toBe(workspaceRoot);
  }, 20_000);

  // case: S-325.4
  it('exports original bytes independently of repository filters and respects private Git excludes', async () => {
    const projectRoot = await makeRepository();
    const workspaceId = 'wt_filter_patch';
    const adapter = new WorktreeWorkspaceAdapter({ toolDistPaths: [], initSubmodules: false, installDeps: false });
    const workspace = await adapter.materialize({ workspaceId, sourceRef: 'HEAD', projectRoot, metadata: { runId: ownerRunId } });
    const root = workspace.rootPath!;
    await writeFile(path.join(root, '.gitattributes'), '*.bin filter=local-format\n');
    execFileSync('git', ['-C', projectRoot, 'config', 'filter.local-format.clean', 'false']);
    execFileSync('git', ['-C', projectRoot, 'config', 'filter.local-format.required', 'true']);
    await writeFile(path.join(projectRoot, '.git', 'info', 'exclude'), 'private.log\n');
    await writeFile(path.join(root, 'private.log'), 'private fixture');
    await writeFile(path.join(root, 'image.bin'), Buffer.from([0, 125, 255, 1]));
    const exported = await adapter.exportPatch({ ownerRunId, workspaceId, projectRoot, workspaceRoot: root });
    expect(exported.changedFiles).toEqual(['.gitattributes', 'image.bin']);
    expect((await collect(exported.patch)).toString()).toContain('GIT binary patch');
  });

  // case: S-325.4
  it('fails capture for embedded repositories whose changes a single patch cannot transport', async () => {
    const projectRoot = await makeRepository();
    const workspaceId = 'wt_nested';
    const adapter = new WorktreeWorkspaceAdapter({ toolDistPaths: [], initSubmodules: false, installDeps: false });
    const { rootPath } = await adapter.materialize({ workspaceId, sourceRef: 'HEAD', projectRoot, metadata: { runId: ownerRunId } });
    const nested = path.join(rootPath!, 'nested');
    execFileSync('git', ['clone', '-q', projectRoot, nested]);
    await writeFile(path.join(nested, 'tracked.txt'), 'agent work inside nested repository');
    await expect(adapter.exportPatch({ ownerRunId, workspaceId, projectRoot, workspaceRoot: rootPath! })).rejects.toMatchObject({ code: 'KB_WORKSPACE_PATCH_EXPORT_FAILED' });
  });

  it('refuses to export when the recorded workspace path is no longer its Git toplevel', async () => {
    const projectRoot = await makeRepository();
    const adapter = new WorktreeWorkspaceAdapter({ toolDistPaths: [], initSubmodules: false, installDeps: false });
    await adapter.materialize({ workspaceId: 'wt_wrong_root', sourceRef: 'HEAD', projectRoot, metadata: { runId: ownerRunId } });
    const record = (adapter as unknown as { records: Map<string, { worktreePath: string }> }).records.get('wt_wrong_root')!;
    record.worktreePath = path.join(record.worktreePath, 'nested');
    await expect(adapter.exportPatch({ ownerRunId, workspaceId: 'wt_wrong_root', projectRoot, workspaceRoot: path.join(projectRoot, '.worktrees/wt_wrong_root') })).rejects.toMatchObject({ code: 'KB_WORKSPACE_PATCH_ROOT_MISMATCH' });
  });
});
