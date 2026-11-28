import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorktreeWorkspaceAdapter } from './index.js';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

describe('WorktreeWorkspaceAdapter real Git integration', () => {
  it('links only the platform CLI, launches it with pnpm, and keeps package build output isolated', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'kb-worktree-adapter-'));
    const projectRoot = path.join(root, 'project');
    const platformRoot = path.join(root, 'platform');
    const cliDist = path.join(platformRoot, 'cli', 'bin', 'dist');
    const workspaceId = 'wt-integration';
    const adapter = new WorktreeWorkspaceAdapter({
      workspace: { projectRoot, platformRoot },
      initSubmodules: false,
      installDeps: false,
    });

    try {
      await mkdir(path.join(projectRoot, 'packages', 'demo', 'src'), { recursive: true });
      await mkdir(cliDist, { recursive: true });
      await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
        name: 'worktree-fixture',
        version: '1.0.0',
        private: true,
        scripts: { kb: 'node ./cli/bin/dist/bin.js' },
      }, null, 2));
      await writeFile(path.join(projectRoot, 'packages', 'demo', 'src', 'index.js'), 'export {}\n');
      await writeFile(path.join(cliDist, 'bin.js'), [
        '#!/usr/bin/env node',
        'console.log(`fixture-kb:${process.version}:${process.argv.slice(2).join(" ")}`);',
        '',
      ].join('\n'));

      git(projectRoot, 'init', '-b', 'main');
      git(projectRoot, 'config', 'user.email', 'worktree-test@example.test');
      git(projectRoot, 'config', 'user.name', 'Worktree Test');
      git(projectRoot, 'add', 'package.json', 'packages/demo/src/index.js');
      git(projectRoot, 'commit', '-m', 'Create worktree integration fixture');

      const descriptor = await adapter.materialize({ workspaceId, sourceRef: 'main' });
      const worktreeRoot = descriptor.rootPath;
      expect(worktreeRoot).toBe(path.join(projectRoot, '.worktrees', workspaceId));

      const toolDist = path.join(worktreeRoot!, 'cli', 'bin', 'dist');
      expect((await lstat(toolDist)).isSymbolicLink()).toBe(true);
      expect(await realpath(toolDist)).toBe(await realpath(cliDist));

      const cliOutput = execFileSync('pnpm', ['kb', '--version'], {
        cwd: worktreeRoot,
        encoding: 'utf8',
        stdio: 'pipe',
      });
      expect(cliOutput).toContain(`fixture-kb:${process.version}:--version`);

      const artifactRelativePath = path.join('packages', 'demo', 'dist', 'agent-output.js');
      const worktreeArtifact = path.join(worktreeRoot!, artifactRelativePath);
      await mkdir(path.dirname(worktreeArtifact), { recursive: true });
      await writeFile(worktreeArtifact, 'built only in the worktree\n');

      expect((await lstat(path.dirname(worktreeArtifact))).isSymbolicLink()).toBe(false);
      expect(await readFile(worktreeArtifact, 'utf8')).toBe('built only in the worktree\n');
      expect(existsSync(path.join(projectRoot, artifactRelativePath))).toBe(false);
      expect(existsSync(path.join(platformRoot, artifactRelativePath))).toBe(false);
    } finally {
      await adapter.destroy(workspaceId);
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
