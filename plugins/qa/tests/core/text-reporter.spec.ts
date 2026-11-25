import { describe, expect, it } from 'vitest';
import { buildRunReport } from '../../src/core/report/text-reporter.js';

describe('buildRunReport', () => {
  it('prints current scheduled counts and supports legacy totals', () => {
    const current = buildRunReport({
      raw: { ok: true, elapsed: '1s', results: [], summary: { scheduled: 2, passed: 2, failed: 0, cached: 0 } },
    } as never);
    const legacy = buildRunReport({
      raw: { ok: true, elapsed: '1s', results: [], summary: { total: 3, passed: 3, failed: 0, cached: 0 } },
    } as never);

    expect(current.at(-1)?.lines[0]).toContain('total 2');
    expect(legacy.at(-1)?.lines[0]).toContain('total 3');
  });

  it('shows the original DevKit failure in a failed run report', () => {
    const report = buildRunReport({
      raw: {
        ok: false, elapsed: '1s', results: [],
        error: { code: 'KB_DEVKIT_TASK_FAILED', message: 'core build failed', hint: 'inspect the log' },
        summary: { scheduled: 3, passed: 0, failed: 1, cached: 0, blocked: 2 },
      },
    } as never);

    expect(report.at(-1)?.lines).toContain('DevKit error: core build failed');
    expect(report.at(-1)?.lines).toContain('Hint: inspect the log');
  });
});
