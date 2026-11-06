import { describe, it, expect } from 'vitest';
import { buildCaseTimeline, analyzeFlakyCases, caseKeyOf } from '../../src/core/analysis/case-timeline.js';
import type { E2eFlakySnapshot, E2eCaseResult, E2eErrorCategory } from '@kb-labs/qa/contracts';

function makeCase(
  suite: string,
  spec: string,
  testId: string,
  outcome: E2eCaseResult['outcome'],
  errorCategory?: E2eErrorCategory,
): E2eCaseResult {
  const failed = outcome === 'failed' || outcome === 'flaky';
  return {
    suite,
    spec,
    testId,
    title: `${testId} title`,
    outcome,
    attempts: failed
      ? [
          { status: 'failed', retry: 0, durationMs: 100, errorCategory, errorMessage: 'boom' },
          ...(outcome === 'flaky' ? [{ status: 'passed' as const, retry: 1, durationMs: 100 }] : []),
        ]
      : [{ status: 'passed', retry: 0, durationMs: 100 }],
  };
}

function makeSnap(ts: string, cases: E2eCaseResult[]): E2eFlakySnapshot {
  return { kind: 'e2e-flaky', id: ts, timestamp: ts, durationMs: 1000, cases };
}

describe('caseKeyOf', () => {
  it('builds a stable suite/spec#testId key', () => {
    expect(caseKeyOf({ suite: 'gateway', spec: 'auth.spec.ts', testId: 'GW-1' })).toBe('gateway/auth.spec.ts#GW-1');
  });
});

describe('buildCaseTimeline', () => {
  it('returns null for unknown case', () => {
    const history = [makeSnap('t1', [makeCase('gw', 'a.spec.ts', 'A-1', 'passed')])];
    expect(buildCaseTimeline(history, 'gw/a.spec.ts#unknown')).toBeNull();
  });

  it('builds history entries for the case', () => {
    const history = [
      makeSnap('t1', [makeCase('gw', 'a.spec.ts', 'A-1', 'passed')]),
      makeSnap('t2', [makeCase('gw', 'a.spec.ts', 'A-1', 'failed', 'assertion-race')]),
    ];
    const tl = buildCaseTimeline(history, 'gw/a.spec.ts#A-1');
    expect(tl?.history).toHaveLength(2);
    expect(tl?.suite).toBe('gw');
  });

  it('detects flakiness from status flips including the "flaky" outcome', () => {
    const key = 'gw/a.spec.ts#A-1';
    const history = [
      makeSnap('t1', [makeCase('gw', 'a.spec.ts', 'A-1', 'passed')]),
      makeSnap('t2', [makeCase('gw', 'a.spec.ts', 'A-1', 'flaky', 'infra-timeout')]),
      makeSnap('t3', [makeCase('gw', 'a.spec.ts', 'A-1', 'passed')]),
      makeSnap('t4', [makeCase('gw', 'a.spec.ts', 'A-1', 'flaky', 'infra-timeout')]),
    ];
    const tl = buildCaseTimeline(history, key);
    expect(tl?.flakyScore).toBeGreaterThan(0);
  });

  it('does not mark a stable case as flaky', () => {
    const history = [
      makeSnap('t1', [makeCase('gw', 'a.spec.ts', 'A-1', 'passed')]),
      makeSnap('t2', [makeCase('gw', 'a.spec.ts', 'A-1', 'passed')]),
      makeSnap('t3', [makeCase('gw', 'a.spec.ts', 'A-1', 'passed')]),
    ];
    const tl = buildCaseTimeline(history, 'gw/a.spec.ts#A-1');
    expect(tl?.flakyScore).toBe(0);
  });

  it('computes current streak correctly', () => {
    const history = [
      makeSnap('t1', [makeCase('gw', 'a.spec.ts', 'A-1', 'failed', 'assertion-race')]),
      makeSnap('t2', [makeCase('gw', 'a.spec.ts', 'A-1', 'passed')]),
      makeSnap('t3', [makeCase('gw', 'a.spec.ts', 'A-1', 'passed')]),
    ];
    const tl = buildCaseTimeline(history, 'gw/a.spec.ts#A-1');
    expect(tl?.currentStreak.status).toBe('passing');
    expect(tl?.currentStreak.count).toBe(2);
  });

  it('detects first failure timestamp', () => {
    const history = [
      makeSnap('2024-01-01T00:00:00.000Z', [makeCase('gw', 'a.spec.ts', 'A-1', 'passed')]),
      makeSnap('2024-01-02T00:00:00.000Z', [makeCase('gw', 'a.spec.ts', 'A-1', 'failed', 'ws-flake')]),
      makeSnap('2024-01-03T00:00:00.000Z', [makeCase('gw', 'a.spec.ts', 'A-1', 'failed', 'ws-flake')]),
    ];
    const tl = buildCaseTimeline(history, 'gw/a.spec.ts#A-1');
    expect(tl?.firstFailure).toBe('2024-01-02T00:00:00.000Z');
  });

  it('does not count a run of skipped outcomes as a passing streak', () => {
    const history = [
      makeSnap('t1', [makeCase('gw', 'a.spec.ts', 'A-1', 'failed', 'assertion-race')]),
      makeSnap('t2', [makeCase('gw', 'a.spec.ts', 'A-1', 'skipped')]),
      makeSnap('t3', [makeCase('gw', 'a.spec.ts', 'A-1', 'skipped')]),
    ];
    const tl = buildCaseTimeline(history, 'gw/a.spec.ts#A-1');
    // The last non-skipped entry (t1) was a failure — skipped runs must not
    // fabricate a "passing" streak on top of it.
    expect(tl?.currentStreak.status).toBe('failing');
    expect(tl?.currentStreak.count).toBe(1);
  });
});

describe('analyzeFlakyCases', () => {
  it('returns an empty overview for no history', () => {
    const overview = analyzeFlakyCases([], 5);
    expect(overview.runsAnalyzed).toBe(0);
    expect(overview.top).toHaveLength(0);
  });

  it('lists only cases with non-zero flakyScore in top, sorted descending', () => {
    const history = [
      makeSnap('t1', [
        makeCase('gw', 'a.spec.ts', 'A-1', 'passed'),
        makeCase('gw', 'b.spec.ts', 'B-1', 'passed'),
      ]),
      makeSnap('t2', [
        makeCase('gw', 'a.spec.ts', 'A-1', 'flaky', 'infra-timeout'),
        makeCase('gw', 'b.spec.ts', 'B-1', 'passed'),
      ]),
      makeSnap('t3', [
        makeCase('gw', 'a.spec.ts', 'A-1', 'passed'),
        makeCase('gw', 'b.spec.ts', 'B-1', 'passed'),
      ]),
    ];
    const overview = analyzeFlakyCases(history, 3);
    expect(overview.totalCases).toBe(2);
    expect(overview.flakyCases).toBe(1);
    expect(overview.top[0]?.case).toBe('gw/a.spec.ts#A-1');
    expect(overview.top).toHaveLength(1);
  });

  it('computes delta between current and previous window', () => {
    const history = [
      // previous window: A-1 flaky, B-1 stable
      makeSnap('t1', [makeCase('gw', 'a.spec.ts', 'A-1', 'passed'), makeCase('gw', 'b.spec.ts', 'B-1', 'passed')]),
      makeSnap('t2', [makeCase('gw', 'a.spec.ts', 'A-1', 'flaky', 'infra-timeout'), makeCase('gw', 'b.spec.ts', 'B-1', 'passed')]),
      // current window: A-1 stable again (fixed), B-1 now flaky (new)
      makeSnap('t3', [makeCase('gw', 'a.spec.ts', 'A-1', 'passed'), makeCase('gw', 'b.spec.ts', 'B-1', 'passed')]),
      makeSnap('t4', [makeCase('gw', 'a.spec.ts', 'A-1', 'passed'), makeCase('gw', 'b.spec.ts', 'B-1', 'flaky', 'assertion-race')]),
    ];
    const overview = analyzeFlakyCases(history, 2);
    expect(overview.delta.new).toContain('gw/b.spec.ts#B-1');
    expect(overview.delta.fixed).toContain('gw/a.spec.ts#A-1');
  });

  it('reports a case as fixed even if it disappears entirely from the current window', () => {
    const history = [
      // previous window: A-1 flaky
      makeSnap('t1', [makeCase('gw', 'a.spec.ts', 'A-1', 'passed')]),
      makeSnap('t2', [makeCase('gw', 'a.spec.ts', 'A-1', 'flaky', 'infra-timeout')]),
      // current window: A-1 doesn't appear at all (spec renamed/deleted) — only B-1 runs
      makeSnap('t3', [makeCase('gw', 'b.spec.ts', 'B-1', 'passed')]),
      makeSnap('t4', [makeCase('gw', 'b.spec.ts', 'B-1', 'passed')]),
    ];
    const overview = analyzeFlakyCases(history, 2);
    expect(overview.delta.fixed).toContain('gw/a.spec.ts#A-1');
  });

  it('buckets flaky cases byCategory using the most recent error', () => {
    const history = [
      makeSnap('t1', [makeCase('gw', 'a.spec.ts', 'A-1', 'passed')]),
      makeSnap('t2', [makeCase('gw', 'a.spec.ts', 'A-1', 'flaky', 'ws-flake')]),
    ];
    const overview = analyzeFlakyCases(history, 2);
    expect(overview.byCategory['ws-flake']).toBe(1);
  });
});
