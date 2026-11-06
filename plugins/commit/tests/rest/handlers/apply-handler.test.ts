/**
 * Tests for apply-handler.ts - REST endpoint for commit application
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { simpleGit } from 'simple-git';
import type { PluginContextV3, RestInput } from '@kb-labs/sdk';
import { createTestContext } from '@kb-labs/sdk/testing';
import type { ApplyRequest } from '@kb-labs/commit/contracts';
import applyHandler from '../../../src/rest/handlers/apply-handler';
import { savePlan } from '@kb-labs/commit/core/storage';
import type { CommitPlan } from '@kb-labs/commit/contracts';

vi.mock('@kb-labs/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kb-labs/sdk')>();
  return {
    ...actual,
    useConfig: vi.fn().mockResolvedValue({
      scope: {
        scopes: [
          { id: '@kb-labs/commit-cli', path: 'kb-labs-commit-plugin' },
          { id: '@kb-labs/setup-engine', path: 'kb-labs-setup-engine' },
        ],
      },
    }),
  };
});

const contextCleanups: Array<() => void> = [];
function createHandlerContext(cwd: string): PluginContextV3 {
  const { ctx, cleanup } = createTestContext({ cwd, host: 'rest' });
  contextCleanups.push(cleanup);
  return ctx;
}

function cleanupHandlerContexts(): void {
  for (const cleanup of contextCleanups.splice(0)) cleanup();
}

describe('apply-handler - path transformation for scoped repos', () => {
  const testRoot = join(process.cwd(), '.test-apply-handler');
  const rootCwd = join(testRoot, 'kb-labs');
  const nestedRepo = join(testRoot, 'kb-labs', 'kb-labs-commit-plugin');

  beforeEach(async () => {
    // Create directory structure
    await mkdir(join(nestedRepo, 'packages', 'commit-cli', 'src'), { recursive: true });

    // Initialize nested git repo
    const nestedGit = simpleGit(nestedRepo);
    await nestedGit.init();
    await nestedGit.addConfig('user.name', 'Test User');
    await nestedGit.addConfig('user.email', 'test@example.com');

    // Add test files
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
    cleanupHandlerContexts();
  });

  it('should transform file paths from repoRoot-relative to scope-relative', async () => {
    // Create plan with paths relative to rootCwd (kb-labs)
    const plan: CommitPlan = {
      schemaVersion: '1.0',
      createdAt: new Date().toISOString(),
      repoRoot: rootCwd,
      gitStatus: {
        staged: [],
        unstaged: [
          'kb-labs-commit-plugin/packages/commit-cli/src/handler.ts',
          'kb-labs-commit-plugin/packages/commit-cli/src/utils.ts',
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
            'kb-labs-commit-plugin/packages/commit-cli/src/handler.ts',
            'kb-labs-commit-plugin/packages/commit-cli/src/utils.ts',
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

    // Save plan to storage
    await savePlan(rootCwd, plan, '@kb-labs/commit-cli');

    // Create mock context
    const ctx = createHandlerContext(rootCwd);

    const input: RestInput<unknown, ApplyRequest> = {
      body: {
        scope: '@kb-labs/commit-cli',
        force: false,
      },
    };

    // Execute handler
    const result = await applyHandler.execute(ctx as PluginContextV3, input);

    // Should succeed - paths were transformed correctly
    expect(result.result.success).toBe(true);
    expect(result.result.appliedCommits).toHaveLength(1);
    expect(result.result.errors).toHaveLength(0);

    // Verify commit was created in nested repo
    const nestedGit = simpleGit(nestedRepo);
    const log = await nestedGit.log();
    expect(log.latest?.message).toContain('feat(cli): add handler and utils');
  });

  it('should fail staleness check when file paths are not transformed', async () => {
    // Create plan with paths that DON'T match scope (simulating bug)
    const plan: CommitPlan = {
      schemaVersion: '1.0',
      createdAt: new Date().toISOString(),
      repoRoot: rootCwd,
      gitStatus: {
        staged: [],
        unstaged: [
          'kb-labs-commit-plugin/packages/commit-cli/src/nonexistent.ts',
        ],
        untracked: [],
      },
      commits: [
        {
          id: 'c1',
          type: 'feat',
          scope: 'cli',
          message: 'add nonexistent file',
          files: [
            'kb-labs-commit-plugin/packages/commit-cli/src/nonexistent.ts',
          ],
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

    await savePlan(rootCwd, plan, '@kb-labs/commit-cli');

    const ctx = createHandlerContext(rootCwd);

    const input: RestInput<unknown, ApplyRequest> = {
      body: {
        scope: '@kb-labs/commit-cli',
        force: false,
      },
    };

    // Should fail due to staleness
    const result = await applyHandler.execute(ctx as PluginContextV3, input);

    expect(result.result.success).toBe(false);
    expect(result.result.errors).toHaveLength(1);
    expect(result.result.errors[0]).toContain('File no longer has changes');
  });

  it('should bypass staleness check with force option', async () => {
    const plan: CommitPlan = {
      schemaVersion: '1.0',
      createdAt: new Date().toISOString(),
      repoRoot: rootCwd,
      gitStatus: {
        staged: [],
        unstaged: [
          'kb-labs-commit-plugin/packages/commit-cli/src/handler.ts',
        ],
        untracked: [],
      },
      commits: [
        {
          id: 'c1',
          type: 'feat',
          scope: 'cli',
          message: 'add handler',
          files: [
            'kb-labs-commit-plugin/packages/commit-cli/src/handler.ts',
          ],
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

    await savePlan(rootCwd, plan, '@kb-labs/commit-cli');

    const ctx = createHandlerContext(rootCwd);

    const input: RestInput<unknown, ApplyRequest> = {
      body: {
        scope: '@kb-labs/commit-cli',
        force: true, // Force should bypass staleness
      },
    };

    const result = await applyHandler.execute(ctx as PluginContextV3, input);

    expect(result.result.success).toBe(true);
    expect(result.result.appliedCommits).toHaveLength(1);
  });
});

describe('apply-handler - scope prefix edge cases', () => {
  const testRoot = join(process.cwd(), '.test-apply-handler-edge');
  const rootCwd = join(testRoot, 'kb-labs');
  const setupRepo = join(testRoot, 'kb-labs', 'kb-labs-setup-engine');

  beforeEach(async () => {
    await mkdir(join(setupRepo, 'packages', 'setup-core'), { recursive: true });

    const setupGit = simpleGit(setupRepo);
    await setupGit.init();
    await setupGit.addConfig('user.name', 'Test User');
    await setupGit.addConfig('user.email', 'test@example.com');

    await writeFile(
      join(setupRepo, 'packages', 'setup-core', 'package.json'),
      '{"name": "@kb-labs/setup-core"}'
    );
  });

  afterEach(async () => {
    await rm(testRoot, { recursive: true, force: true });
    cleanupHandlerContexts();
  });

  it('should handle deeply nested scope paths correctly', async () => {
    const plan: CommitPlan = {
      schemaVersion: '1.0',
      createdAt: new Date().toISOString(),
      repoRoot: rootCwd,
      gitStatus: {
        staged: [],
        unstaged: [
          'kb-labs-setup-engine/packages/setup-core/package.json',
        ],
        untracked: [],
      },
      commits: [
        {
          id: 'c1',
          type: 'chore',
          scope: 'setup',
          message: 'update package.json',
          files: [
            'kb-labs-setup-engine/packages/setup-core/package.json',
          ],
          releaseHint: 'none',
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

    await savePlan(rootCwd, plan, '@kb-labs/setup-engine');

    const ctx = createHandlerContext(rootCwd);

    const input: RestInput<unknown, ApplyRequest> = {
      body: {
        scope: '@kb-labs/setup-engine',
        force: false,
      },
    };

    const result = await applyHandler.execute(ctx as PluginContextV3, input);

    expect(result.result.success).toBe(true);
    expect(result.result.appliedCommits).toHaveLength(1);

    // Verify file was committed with correct path (relative to setupRepo)
    const setupGit = simpleGit(setupRepo);
    const log = await setupGit.log();
    const commit = await setupGit.show(['--name-only', '--format=%s', log.latest!.hash]);
    expect(commit).toContain('packages/setup-core/package.json');
    expect(commit).not.toContain('kb-labs-setup-engine'); // Should NOT have full prefix
  });

  it('should handle root scope (no prefix)', async () => {
    // Create git repo at root
    const rootGit = simpleGit(rootCwd);
    await rootGit.init();
    await rootGit.addConfig('user.name', 'Test User');
    await rootGit.addConfig('user.email', 'test@example.com');

    await writeFile(join(rootCwd, 'README.md'), '# KB Labs');

    const plan: CommitPlan = {
      schemaVersion: '1.0',
      createdAt: new Date().toISOString(),
      repoRoot: rootCwd,
      gitStatus: {
        staged: [],
        unstaged: ['README.md'],
        untracked: [],
      },
      commits: [
        {
          id: 'c1',
          type: 'docs',
          message: 'add README',
          files: ['README.md'],
          releaseHint: 'none',
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

    await savePlan(rootCwd, plan, 'root');

    const ctx = createHandlerContext(rootCwd);

    const input: RestInput<unknown, ApplyRequest> = {
      body: {
        scope: 'root',
        force: false,
      },
    };

    const result = await applyHandler.execute(ctx as PluginContextV3, input);

    expect(result.result.success).toBe(true);
    expect(result.result.appliedCommits).toHaveLength(1);
  });
});
