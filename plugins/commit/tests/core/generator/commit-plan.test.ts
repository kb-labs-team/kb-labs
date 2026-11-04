/**
 * Tests for commit-plan.ts's LLM gating.
 *
 * BUG-03: `kb commit commit` called the gateway LLM even when the plugin's
 * config had LLM disabled. resolveContext() in run.ts already computed
 * `llmComplete: undefined` for that case, but generateCommitPlan() ignored it
 * and instead checked `useLLM()` directly — which stays truthy whenever the
 * platform has *any* LLM adapter registered, independent of this plugin's
 * llm.enabled setting.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { simpleGit } from 'simple-git';
import { createTestContext, mockLLM } from '@kb-labs/sdk/testing';
import { generateCommitPlan } from '../../../src/core/generator/commit-plan.js';

describe('generateCommitPlan - LLM gating', () => {
  const repoDir = join(process.cwd(), '.test-commit-plan-llm-gating');

  beforeEach(async () => {
    await mkdir(repoDir, { recursive: true });
    const git = simpleGit(repoDir);
    await git.init();
    await git.addConfig('user.name', 'Test User');
    await git.addConfig('user.email', 'test@example.com');

    await writeFile(join(repoDir, 'a.ts'), 'export const a = 1;\n');
    await git.add('.');
    await git.commit('chore: initial commit');

    await writeFile(join(repoDir, 'a.ts'), 'export const a = 2;\n');
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it('requires a configured LLM for plan generation when llmComplete is undefined', async () => {
    const llm = mockLLM();
    const { cleanup } = createTestContext({ platform: { llm } });
    const onOutput = vi.fn();

    try {
      await expect(generateCommitPlan({
        cwd: repoDir,
        llmComplete: undefined, // exactly what resolveContext() passes when config.llm.enabled is false
        onOutput,
      })).rejects.toMatchObject({ slot: 'llm', reason: 'not-configured' });

      expect(llm.complete).not.toHaveBeenCalled();
      expect(llm.chatWithTools).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('does call the gateway LLM when llmComplete is provided (LLM enabled)', async () => {
    const llm = mockLLM();
    const { cleanup } = createTestContext({ platform: { llm } });
    const onOutput = vi.fn();

    try {
      await generateCommitPlan({
        cwd: repoDir,
        llmComplete: async (prompt: string) => ({ content: 'feat: update a.ts' }),
        onOutput,
      });

      const calledComplete = (llm.complete as unknown as { mock: { calls: unknown[] } }).mock.calls.length > 0;
      const calledTools = (llm.chatWithTools as unknown as { mock: { calls: unknown[] } }).mock.calls.length > 0;
      expect(calledComplete || calledTools).toBe(true);
    } finally {
      cleanup();
    }
  });
});
