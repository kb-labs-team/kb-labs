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
});
