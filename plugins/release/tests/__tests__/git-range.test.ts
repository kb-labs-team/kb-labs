import { describe, expect, it, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveGitRange } from '../../src/changelog/git-range';

const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'kb-changelog-range-'));
  roots.push(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');

  const commit = (message: string) => {
    writeFileSync(join(root, `${message.replace(/[^a-z]/gi, '-')}.txt`), message);
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', message);
  };

  commit('initial release');
  git(root, 'tag', 'v9.99.0'); // Would win under the former lexical sort.
  commit('platform release');
  git(root, 'tag', 'platform-v2.118.2');
  commit('sdk release');
  git(root, 'tag', 'sdk-v2.115.4');
  commit('next change');
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) { rmSync(root, { recursive: true, force: true }); }
});

describe('resolveGitRange', () => {
  it('uses the nearest reachable tag matching the active flow', async () => {
    const root = makeRepo();

    await expect(resolveGitRange({ cwd: root, tagGlob: 'platform-v*' }))
      .resolves.toEqual({ from: 'platform-v2.118.2', to: 'HEAD' });
  });

  it('honors an explicit boundary over automatic tag discovery', async () => {
    const root = makeRepo();

    await expect(resolveGitRange({ cwd: root, tagGlob: 'platform-v*', sinceTag: 'sdk-v2.115.4' }))
      .resolves.toEqual({ from: 'sdk-v2.115.4', to: 'HEAD' });
  });
});
