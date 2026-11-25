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
});
