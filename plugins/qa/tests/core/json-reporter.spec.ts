import { describe, expect, it } from 'vitest';
import { buildRunJsonReport } from '../../src/core/report/json-reporter.js';

describe('buildRunJsonReport', () => {
  it('includes the original DevKit failure in a failed run snapshot report', () => {
    const report = buildRunJsonReport({
      id: 'snapshot-1', timestamp: '2026-01-01T00:00:00.000Z', durationMs: 1,
      kind: 'run', tasks: ['test'],
      raw: {
        elapsed: '1s', ok: false,
        error: { code: 'KB_DEVKIT_TASK_FAILED', message: 'build failed', hint: 'inspect log' },
        results: [], summary: { scheduled: 1, passed: 0, failed: 1, cached: 0 },
      },
    } as never);

    expect(report).toMatchObject({
      ok: false,
      error: { code: 'KB_DEVKIT_TASK_FAILED', message: 'build failed', hint: 'inspect log' },
    });
  });
});
