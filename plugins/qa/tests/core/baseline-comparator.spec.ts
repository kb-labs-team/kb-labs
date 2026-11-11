import { describe, it, expect } from 'vitest';
import { compareWithBaseline } from '../../src/core/analysis/baseline-comparator.js';
import type { DevkitCheckOutput, DevkitStatsOutput, BaselineData } from '@kb-labs/qa/contracts';

function makeCheck(issues: Array<{ pkg: string; check: string; message: string; severity?: 'error' | 'warning' | 'info' }>): DevkitCheckOutput {
  const packages: DevkitCheckOutput['packages'] = {};
  for (const { pkg, check, message, severity = 'error' } of issues) {
    packages[pkg] ??= { ok: false, issues: [] };
    packages[pkg]!.issues!.push({ check, message, severity });
  }
  return { ok: Object.keys(packages).length === 0, packages };
}

function makeStats(score: number, grade = 'B'): DevkitStatsOutput {
  return {
    ok: true, score, grade,
    summary: { total: 5, healthy: 3, warning: 1, error: 1, total_errors: 2, total_warnings: 3 },
    by_category: {}, issues_by_type: {}, coverage: {},
  };
}

function makeBaseline(check: DevkitCheckOutput, stats: DevkitStatsOutput): BaselineData {
  return { timestamp: '2024-01-01T00:00:00.000Z', check, stats };
}

describe('compareWithBaseline', () => {
  it('identifies new issues not in baseline', () => {
    const baseline = makeBaseline(makeCheck([]), makeStats(90));
    const current = makeCheck([{ pkg: 'a', check: 'lint', message: 'line too long' }]);
    const diff = compareWithBaseline(current, makeStats(88), baseline);
    expect(diff.newIssues).toHaveLength(1);
    expect(diff.newIssues[0]!.pkg).toBe('a');
    expect(diff.newIssues[0]!.status).toBe('new');
    expect(diff.newIssueCount).toBe(1);
  });

  it('identifies fixed issues present in baseline but not current', () => {
    const baselineCheck = makeCheck([{ pkg: 'a', check: 'readme', message: 'missing README' }]);
    const baseline = makeBaseline(baselineCheck, makeStats(80));
    const diff = compareWithBaseline(makeCheck([]), makeStats(85), baseline);
    expect(diff.fixedIssues).toHaveLength(1);
    expect(diff.fixedIssues[0]!.status).toBe('fixed');
    expect(diff.fixedIssueCount).toBe(1);
  });

  it('identifies persisting issues in both baseline and current', () => {
    const issue = { pkg: 'a', check: 'tsconfig', message: 'no tsconfig found' };
    const check = makeCheck([issue]);
    const baseline = makeBaseline(check, makeStats(75));
    const diff = compareWithBaseline(check, makeStats(75), baseline);
    expect(diff.persistingIssues).toHaveLength(1);
    expect(diff.persistingIssues[0]!.status).toBe('persisting');
    expect(diff.newIssues).toHaveLength(0);
    expect(diff.fixedIssues).toHaveLength(0);
  });

  it('calculates score delta correctly', () => {
    const baseline = makeBaseline(makeCheck([]), makeStats(80, 'B'));
    const diff = compareWithBaseline(makeCheck([]), makeStats(85, 'B'), baseline);
    expect(diff.scoreDelta).toBe(5);
    expect(diff.gradeDelta).toBe('B → B');
  });

  it('returns negative score delta on regression', () => {
    const baseline = makeBaseline(makeCheck([]), makeStats(90, 'A'));
    const diff = compareWithBaseline(makeCheck([{ pkg: 'a', check: 'x', message: 'y' }]), makeStats(82, 'B'), baseline);
    expect(diff.scoreDelta).toBe(-8);
    expect(diff.gradeDelta).toBe('A → B');
  });

  it('uses pkg::check::message as the deduplication key', () => {
    // Same check name but different message → different issues
    const baseline = makeBaseline(
      makeCheck([{ pkg: 'a', check: 'lint', message: 'rule A' }]),
      makeStats(85),
    );
    const current = makeCheck([{ pkg: 'a', check: 'lint', message: 'rule B' }]);
    const diff = compareWithBaseline(current, makeStats(85), baseline);
    expect(diff.newIssues).toHaveLength(1);   // rule B is new
    expect(diff.fixedIssues).toHaveLength(1); // rule A is fixed
    expect(diff.persistingIssues).toHaveLength(0);
  });
});
