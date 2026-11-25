import { describe, expect, it } from 'vitest';
import { DevkitRunOutputSchema } from '../../src/contracts/types/rest-api.js';

const base = {
  elapsed: '1s',
  ok: true,
  results: [],
};

describe('DevkitRunOutputSchema summary task counts', () => {
  it('accepts the current scheduled field', () => {
    expect(DevkitRunOutputSchema.safeParse({
      ...base,
      summary: { scheduled: 2, passed: 2, failed: 0, cached: 0 },
    }).success).toBe(true);
  });

  it('accepts the legacy total field', () => {
    expect(DevkitRunOutputSchema.safeParse({
      ...base,
      summary: { total: 2, passed: 2, failed: 0, cached: 0 },
    }).success).toBe(true);
  });

  it('rejects a summary with neither task count', () => {
    expect(DevkitRunOutputSchema.safeParse({
      ...base,
      summary: { passed: 0, failed: 0, cached: 0 },
    }).success).toBe(false);
  });

  it('accepts the blockedBy fields emitted by kb-devkit', () => {
    expect(DevkitRunOutputSchema.safeParse({
      ...base,
      ok: false,
      results: [],
      summary: {
        scheduled: 1, passed: 0, failed: 0, cached: 0, blocked: 1,
        blockedTasks: [{
          package: '@fixture/app', task: 'build',
          blockedByPackage: '@fixture/core', blockedByTask: 'build',
        }],
      },
    }).success).toBe(true);
  });

  it('accepts a failed execution envelope error in the persisted run payload', () => {
    expect(DevkitRunOutputSchema.safeParse({
      ...base,
      ok: false,
      error: {
        code: 'KB_DEVKIT_TASK_FAILED',
        message: 'Task build failed',
        hint: 'Inspect the log.',
        details: { package: '@fixture/core', task: 'build' },
      },
      results: [{
        Package: '@fixture/core', Task: 'build', OK: false, Cached: false, Elapsed: 1,
        ExitCode: 1, Stdout: '', Stderr: 'failed', Error: 'failed',
      }],
      summary: { scheduled: 1, passed: 0, failed: 1, cached: 0 },
    }).success).toBe(true);
  });
});
