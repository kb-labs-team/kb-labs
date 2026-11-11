import { describe, expect, it } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { resolveRuntimeStatePath } from '@kb-labs/sdk/adapters';
import { getCommitStoragePath, getCurrentPlanPath, loadPlan } from '../../../src/core/storage/plan-storage.js';

describe('commit plan storage location', () => {
  it('stores runtime plans in the project state directory, not .kb/commit', () => {
    const project = join(process.cwd(), 'fixture-project');
    const expectedRoot = resolveRuntimeStatePath(project, ['commit']);

    expect(getCommitStoragePath(project)).toBe(expectedRoot);
    expect(getCurrentPlanPath(project)).toBe(join(expectedRoot, 'plans', 'root', 'current', 'plan.json'));
    expect(getCommitStoragePath(project)).not.toContain(join(project, '.kb'));
  });

  it('does not load a stale plan from the legacy project-local path', async () => {
    const project = join(process.cwd(), `.test-legacy-commit-storage-${process.pid}`);
    const legacyPlan = join(project, '.kb/commit/plans/root/current/plan.json');
    await mkdir(dirname(legacyPlan), { recursive: true });
    await writeFile(legacyPlan, '{"schemaVersion":"1.0"}');

    try {
      expect(await loadPlan(project)).toBeNull();
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
});
