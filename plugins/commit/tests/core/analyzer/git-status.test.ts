/**
 * Tests for git-status.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { getGitStatus, hasChanges, getAllChangedFiles } from '../../../src/core/analyzer/git-status.js';
import { simpleGit } from 'simple-git';

describe('getGitStatus', () => {
  const testRoot = join(process.cwd(), '.test-git-status');
  const repoDir = join(testRoot, 'repo');

  beforeEach(async () => {
    await mkdir(repoDir, { recursive: true });

    const git = simpleGit(repoDir);
    await git.init();
    await git.addConfig('user.name', 'Test User');
    await git.addConfig('user.email', 'test@example.com');
  });

  afterEach(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });

  it('should return empty status for clean repo', async () => {
    const status = await getGitStatus(repoDir);
    expect(status.staged).toHaveLength(0);
    expect(status.unstaged).toHaveLength(0);
    expect(status.untracked).toHaveLength(0);
  });

  it('should detect untracked files', async () => {
    await writeFile(join(repoDir, 'new-file.ts'), 'export const x = 1;');

    const status = await getGitStatus(repoDir);
    expect(status.untracked).toContain('new-file.ts');
  });

  it('should detect staged files', async () => {
    const filePath = join(repoDir, 'staged.ts');
    await writeFile(filePath, 'export const x = 1;');

    const git = simpleGit(repoDir);
    await git.add('staged.ts');

    const status = await getGitStatus(repoDir);
    expect(status.staged).toContain('staged.ts');
    expect(status.untracked).not.toContain('staged.ts');
  });

  it('should resolve to nested repo when cwd points to it', async () => {
    // Simulate a nested git repo by creating a subdirectory with its own .git
    const nestedDir = join(testRoot, 'nested');
    await mkdir(nestedDir, { recursive: true });

    const nestedGit = simpleGit(nestedDir);
    await nestedGit.init();
    await nestedGit.addConfig('user.name', 'Test User');
    await nestedGit.addConfig('user.email', 'test@example.com');
    await writeFile(join(nestedDir, 'nested-file.ts'), 'export const n = 1;');

    // When cwd is already the nested repo dir, we see nested-file.ts (not prefixed)
    const status = await getGitStatus(nestedDir);
    expect(status.untracked).toContain('nested-file.ts');
  });
});

describe('getAllChangedFiles', () => {
  it('should merge staged, unstaged, untracked without duplicates', () => {
    const status = {
      staged: ['a.ts', 'b.ts'],
      unstaged: ['b.ts', 'c.ts'],
      untracked: ['d.ts'],
    };
    const files = getAllChangedFiles(status);
    expect(files).toContain('a.ts');
    expect(files).toContain('b.ts');
    expect(files).toContain('c.ts');
    expect(files).toContain('d.ts');
    expect(files.filter(f => f === 'b.ts')).toHaveLength(1);
  });
});

describe('hasChanges', () => {
  it('should return false for empty status', () => {
    expect(hasChanges({ staged: [], unstaged: [], untracked: [] })).toBe(false);
  });

  it('should return true when there are staged files', () => {
    expect(hasChanges({ staged: ['a.ts'], unstaged: [], untracked: [] })).toBe(true);
  });
});

describe('getGitStatus runtime state filtering', () => {
  const repo = join(process.cwd(), '.test-commit-runtime-state');

  beforeEach(async () => {
    await mkdir(repo, { recursive: true });
    await simpleGit(repo).init();
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('does not include stale commit plans under .kb/commit', async () => {
    await mkdir(join(repo, '.kb/commit/plans/root/current'), { recursive: true });
    await writeFile(join(repo, '.kb/commit/plans/root/current/plan.json'), '{}');
    await writeFile(join(repo, 'README.md'), '# User file\n');

    const status = await getGitStatus(repo);
    expect(status.untracked).toEqual(['README.md']);
  });
});
