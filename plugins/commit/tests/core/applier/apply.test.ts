/**
 * Tests for apply.ts - commit application and staleness checking
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { simpleGit } from 'simple-git';
import { applyCommitPlan } from '../../../src/core/applier/apply.js';
import type { CommitPlan } from '@kb-labs/commit/contracts';

describe('applyCommitPlan - scoped repositories', () => {
  const testRoot = join(process.cwd(), '.test-apply-scoped');
  const rootRepo = join(testRoot, 'kb-labs');
  const nestedRepo = join(testRoot, 'kb-labs', 'kb-labs-commit-plugin');

  beforeEach(async () => {
    // Create test directory structure
    await mkdir(join(nestedRepo, 'packages', 'commit-cli', 'src'), { recursive: true });

    // Initialize root git repo (umbrella repo)
    const rootGit = simpleGit(rootRepo);
    await rootGit.init();
    await rootGit.addConfig('user.name', 'Test User');
    await rootGit.addConfig('user.email', 'test@example.com');

    // Initialize nested git repo (submodule)
    const nestedGit = simpleGit(nestedRepo);
    await nestedGit.init();
    await nestedGit.addConfig('user.name', 'Test User');
    await nestedGit.addConfig('user.email', 'test@example.com');

    // Add test files to nested repo
    await writeFile(
      join(nestedRepo, 'packages', 'commit-cli', 'src', 'handler.ts'),
      'export const handler = 1;'
    );
    await writeFile(
      join(nestedRepo, 'packages', 'commit-cli', 'src', 'utils.ts'),
      'export const utils = 1;'
    );
  });

  afterEach(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });

  it('should apply commits when paths are relative to scope', async () => {
    // Simulate plan generated from scope perspective
    // Files are relative to nestedRepo root
    const plan: CommitPlan = {
      schemaVersion: '1.0',
      createdAt: new Date().toISOString(),
      repoRoot: nestedRepo,
      gitStatus: {
        staged: [],
        unstaged: [
          'packages/commit-cli/src/handler.ts',
          'packages/commit-cli/src/utils.ts',
        ],
        untracked: [],
      },
      commits: [
        {
          id: 'c1',
          type: 'feat',
          scope: 'cli',
          message: 'add handler and utils',
          files: [
            'packages/commit-cli/src/handler.ts',
            'packages/commit-cli/src/utils.ts',
          ],
          releaseHint: 'minor',
          breaking: false,
        },
      ],
      metadata: {
        totalFiles: 2,
        totalCommits: 1,
        llmUsed: false,
        tokensUsed: 0,
        escalated: false,
      },
    };

    // Apply commits from nestedRepo perspective
    const result = await applyCommitPlan(nestedRepo, plan);

    expect(result.success).toBe(true);
    expect(result.appliedCommits).toHaveLength(1);
    expect(result.appliedCommits[0]?.sha).toBeDefined();
    expect(result.errors).toHaveLength(0);

    // Verify commit was created in nested repo
    const nestedGit = simpleGit(nestedRepo);
    const log = await nestedGit.log();
    expect(log.latest?.message).toContain('feat(cli): add handler and utils');
  });

  it('should detect staleness when files no longer have changes', async () => {
    // Create a plan with files
    const plan: CommitPlan = {
      schemaVersion: '1.0',
      createdAt: new Date().toISOString(),
      repoRoot: nestedRepo,
      gitStatus: {
        staged: [],
        unstaged: [
          'packages/commit-cli/src/handler.ts',
          'packages/commit-cli/src/nonexistent.ts', // This file doesn't exist!
        ],
        untracked: [],
      },
      commits: [
        {
          id: 'c1',
          type: 'feat',
          scope: 'cli',
          message: 'add files',
          files: [
            'packages/commit-cli/src/handler.ts',
            'packages/commit-cli/src/nonexistent.ts',
          ],
          releaseHint: 'minor',
          breaking: false,
        },
      ],
      metadata: {
        totalFiles: 2,
        totalCommits: 1,
        llmUsed: false,
        tokensUsed: 0,
        escalated: false,
      },
    };

    // Apply should fail due to staleness
    const result = await applyCommitPlan(nestedRepo, plan);

    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('File no longer has changes');
    expect(result.errors[0]).toContain('nonexistent.ts');
  });

  it('should bypass staleness check with force option', async () => {
    // Create a plan with non-existent file
    const plan: CommitPlan = {
      schemaVersion: '1.0',
      createdAt: new Date().toISOString(),
      repoRoot: nestedRepo,
      gitStatus: {
        staged: [],
        unstaged: ['packages/commit-cli/src/nonexistent.ts'],
        untracked: [],
      },
      commits: [
        {
          id: 'c1',
          type: 'feat',
          scope: 'cli',
          message: 'add file',
          files: ['packages/commit-cli/src/nonexistent.ts'],
          releaseHint: 'minor',
          breaking: false,
        },
      ],
      metadata: {
        totalFiles: 1,
        totalCommits: 1,
        llmUsed: false,
        tokensUsed: 0,
        escalated: false,
      },
    };

    // Apply with force should skip staleness check
    // Note: This will still fail at git.add() stage, but it bypasses staleness
    const result = await applyCommitPlan(nestedRepo, plan, { force: true });

    // Expected to fail at git.add() stage, not staleness
    expect(result.success).toBe(false);
    expect(result.errors[0]).not.toContain('File no longer has changes');
  });
});

describe('applyCommitPlan - path transformation edge cases', () => {
  const testRoot = join(process.cwd(), '.test-apply-paths');
  const _rootRepo = join(testRoot, 'kb-labs');
  const nestedRepo = join(testRoot, 'kb-labs', 'kb-labs-setup-engine');

  beforeEach(async () => {
    // Create nested structure
    await mkdir(join(nestedRepo, 'packages', 'setup-core', 'src'), { recursive: true });

    // Initialize nested git repo
    const nestedGit = simpleGit(nestedRepo);
    await nestedGit.init();
    await nestedGit.addConfig('user.name', 'Test User');
    await nestedGit.addConfig('user.email', 'test@example.com');

    // Add test file
    await writeFile(
      join(nestedRepo, 'packages', 'setup-core', 'src', 'index.ts'),
      'export const index = 1;'
    );
  });

  afterEach(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });

  it('should handle deeply nested file paths correctly', async () => {
    const plan: CommitPlan = {
      schemaVersion: '1.0',
      createdAt: new Date().toISOString(),
      repoRoot: nestedRepo,
      gitStatus: {
        staged: [],
        unstaged: ['packages/setup-core/src/index.ts'],
        untracked: [],
      },
      commits: [
        {
          id: 'c1',
          type: 'feat',
          scope: 'setup',
          message: 'add index',
          files: ['packages/setup-core/src/index.ts'],
          releaseHint: 'minor',
          breaking: false,
        },
      ],
      metadata: {
        totalFiles: 1,
        totalCommits: 1,
        llmUsed: false,
        tokensUsed: 0,
        escalated: false,
      },
    };

    const result = await applyCommitPlan(nestedRepo, plan);

    expect(result.success).toBe(true);
    expect(result.appliedCommits).toHaveLength(1);
  });
});

describe('applyCommitPlan - multiple commits', () => {
  const testRoot = join(process.cwd(), '.test-apply-multi');
  const repo = join(testRoot, 'repo');

  beforeEach(async () => {
    await mkdir(join(repo, 'src'), { recursive: true });

    const git = simpleGit(repo);
    await git.init();
    await git.addConfig('user.name', 'Test User');
    await git.addConfig('user.email', 'test@example.com');

    // Create test files
    await writeFile(join(repo, 'src', 'file1.ts'), 'export const file1 = 1;');
    await writeFile(join(repo, 'src', 'file2.ts'), 'export const file2 = 2;');
    await writeFile(join(repo, 'src', 'file3.ts'), 'export const file3 = 3;');
  });

  afterEach(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });

  it('should apply multiple commits in order', async () => {
    const plan: CommitPlan = {
      schemaVersion: '1.0',
      createdAt: new Date().toISOString(),
      repoRoot: repo,
      gitStatus: {
        staged: [],
        unstaged: ['src/file1.ts', 'src/file2.ts', 'src/file3.ts'],
        untracked: [],
      },
      commits: [
        {
          id: 'c1',
          type: 'feat',
          scope: 'core',
          message: 'add file1',
          files: ['src/file1.ts'],
          releaseHint: 'minor',
          breaking: false,
        },
        {
          id: 'c2',
          type: 'feat',
          scope: 'core',
          message: 'add file2',
          files: ['src/file2.ts'],
          releaseHint: 'minor',
          breaking: false,
        },
        {
          id: 'c3',
          type: 'feat',
          scope: 'core',
          message: 'add file3',
          files: ['src/file3.ts'],
          releaseHint: 'minor',
          breaking: false,
        },
      ],
      metadata: {
        totalFiles: 3,
        totalCommits: 3,
        llmUsed: false,
        tokensUsed: 0,
        escalated: false,
      },
    };

    const result = await applyCommitPlan(repo, plan);

    expect(result.success).toBe(true);
    expect(result.appliedCommits).toHaveLength(3);

    // Verify commits are in correct order
    const git = simpleGit(repo);
    const log = await git.log();
    expect(log.all).toHaveLength(3);
    expect(log.all[0]?.message).toContain('add file3'); // Latest
    expect(log.all[1]?.message).toContain('add file2');
    expect(log.all[2]?.message).toContain('add file1'); // Oldest
  });

  it('should stop on first error and preserve repo state', async () => {
    const plan: CommitPlan = {
      schemaVersion: '1.0',
      createdAt: new Date().toISOString(),
      repoRoot: repo,
      gitStatus: {
        staged: [],
        unstaged: ['src/file1.ts', 'src/file2.ts', 'src/file3.ts'],
        untracked: [],
      },
      commits: [
        {
          id: 'c1',
          type: 'feat',
          scope: 'core',
          message: 'add file1',
          files: ['src/file1.ts'],
          releaseHint: 'minor',
          breaking: false,
        },
        {
          id: 'c2',
          type: 'feat',
          scope: 'core',
          message: 'add bad file',
          files: ['src/nonexistent.ts'], // This will fail!
          releaseHint: 'minor',
          breaking: false,
        },
        {
          id: 'c3',
          type: 'feat',
          scope: 'core',
          message: 'add file3',
          files: ['src/file3.ts'],
          releaseHint: 'minor',
          breaking: false,
        },
      ],
      metadata: {
        totalFiles: 3,
        totalCommits: 3,
        llmUsed: false,
        tokensUsed: 0,
        escalated: false,
      },
    };

    const result = await applyCommitPlan(repo, plan);

    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(1);
    // Staleness check now catches commit files not present in git status
    // before touching the repo, so no commits are applied
    expect(result.appliedCommits).toHaveLength(0);
    expect(result.errors[0]).toContain('src/nonexistent.ts');
    // appliedCommits === 0 confirms repo state is fully preserved
  });

  it('should fail preflight when file appears in multiple commits', async () => {
    const plan: CommitPlan = {
      schemaVersion: '1.0',
      createdAt: new Date().toISOString(),
      repoRoot: repo,
      gitStatus: {
        staged: [],
        unstaged: ['src/file1.ts', 'src/file2.ts'],
        untracked: [],
      },
      commits: [
        {
          id: 'c1',
          type: 'feat',
          scope: 'core',
          message: 'add file1',
          files: ['src/file1.ts'],
          releaseHint: 'minor',
          breaking: false,
        },
        {
          id: 'c2',
          type: 'feat',
          scope: 'core',
          message: 'duplicate file1 with file2',
          files: ['src/file1.ts', 'src/file2.ts'],
          releaseHint: 'minor',
          breaking: false,
        },
      ],
      metadata: {
        totalFiles: 2,
        totalCommits: 2,
        llmUsed: false,
        tokensUsed: 0,
        escalated: false,
      },
    };

    const result = await applyCommitPlan(repo, plan);

    expect(result.success).toBe(false);
    expect(result.appliedCommits).toHaveLength(0);
    expect(result.errors.some(e => e.includes('File appears in multiple commits'))).toBe(true);
  });

});

describe('applyCommitPlan - staging area isolation', () => {
  const testRoot = join(process.cwd(), '.test-apply-staging');
  const repo = join(testRoot, 'repo');

  beforeEach(async () => {
    await mkdir(join(repo, 'src'), { recursive: true });

    const git = simpleGit(repo);
    await git.init();
    await git.addConfig('user.name', 'Test User');
    await git.addConfig('user.email', 'test@example.com');

    // Create test files
    await writeFile(join(repo, 'src', 'file1.ts'), 'export const file1 = 1;');
    await writeFile(join(repo, 'src', 'file2.ts'), 'export const file2 = 2;');
    await writeFile(join(repo, 'src', 'extra.ts'), 'export const extra = 1;');

    // Pre-stage extra.ts (should NOT be included in commits)
    await git.add('src/extra.ts');
  });

  afterEach(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });

  it('should only commit specified files, not all staged files', async () => {
    const plan: CommitPlan = {
      schemaVersion: '1.0',
      createdAt: new Date().toISOString(),
      repoRoot: repo,
      gitStatus: {
        staged: ['src/extra.ts'], // Pre-staged file
        unstaged: ['src/file1.ts', 'src/file2.ts'],
        untracked: [],
      },
      commits: [
        {
          id: 'c1',
          type: 'feat',
          scope: 'core',
          message: 'add file1 only',
          files: ['src/file1.ts'], // Only this file should be committed
          releaseHint: 'minor',
          breaking: false,
        },
      ],
      metadata: {
        totalFiles: 3,
        totalCommits: 1,
        llmUsed: false,
        tokensUsed: 0,
        escalated: false,
      },
    };

    const result = await applyCommitPlan(repo, plan);

    expect(result.success).toBe(true);

    // Verify only file1.ts was committed, not extra.ts
    const git = simpleGit(repo);
    const log = await git.log();
    const commit = await git.show(['--name-only', '--format=%s', log.latest!.hash]);

    expect(commit).toContain('src/file1.ts');
    expect(commit).not.toContain('src/extra.ts');

    // Verify extra.ts and file2.ts are NOT staged anymore
    // After reset --, they should be in working tree (modified or untracked)
    const status = await git.status();

    // Files should be in working tree (not staged)
    expect(status.staged).not.toContain('src/extra.ts');
    expect(status.staged).not.toContain('src/file2.ts');

    // file1.ts was committed, should not be in any list
    expect(status.staged).not.toContain('src/file1.ts');
    expect(status.modified).not.toContain('src/file1.ts');
    expect(status.not_added).not.toContain('src/file1.ts');
  });
});
