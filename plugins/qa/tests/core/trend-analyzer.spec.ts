import { describe, it, expect } from 'vitest';
import { analyzeTrends } from '../../src/core/analysis/trend-analyzer.js';
import type { RunSnapshot } from '@kb-labs/qa/contracts';

function makeSnap(ts: string, results: Array<{ pkg: string; task: string; ok: boolean }>): RunSnapshot {
  return {
    kind: 'run',
    id: ts,
    timestamp: ts,
    durationMs: 100,
    tasks: [...new Set(results.map(r => r.task))],
    raw: {
      elapsed: '1s',
      ok: results.every(r => r.ok),
      results: results.map(r => ({
        Package: r.pkg, Task: r.task, OK: r.ok, Cached: false,
        Elapsed: 10, ExitCode: r.ok ? 0 : 1, Stdout: '', Stderr: '', Error: '',
      })),
      summary: {
        total: results.length,
        passed: results.filter(r => r.ok).length,
        failed: results.filter(r => !r.ok).length,
        cached: 0,
      },
    },
  };
}

describe('analyzeTrends', () => {
  it('returns empty tasks for < 2 snapshots', () => {
    const result = analyzeTrends([makeSnap('2024-01-01', [])]);
    expect(result.tasks).toHaveLength(0);
    expect(result.historyCount).toBe(1);
  });

  it('detects regression when failures increase', () => {
    const history = [
      makeSnap('2024-01-01', [{ pkg: 'a', task: 'lint', ok: true }]),
      makeSnap('2024-01-02', [{ pkg: 'a', task: 'lint', ok: false }]),
    ];
    const result = analyzeTrends(history);
    const lintTrend = result.tasks.find(t => t.task === 'lint')!;
    expect(lintTrend.direction).toBe('regression');
    expect(lintTrend.delta).toBe(1);
  });

  it('detects improvement when failures decrease', () => {
    const history = [
      makeSnap('2024-01-01', [{ pkg: 'a', task: 'build', ok: false }, { pkg: 'b', task: 'build', ok: false }]),
      makeSnap('2024-01-02', [{ pkg: 'a', task: 'build', ok: true }, { pkg: 'b', task: 'build', ok: true }]),
    ];
    const result = analyzeTrends(history);
    const trend = result.tasks.find(t => t.task === 'build')!;
    expect(trend.direction).toBe('improvement');
    expect(trend.delta).toBe(-2);
  });

  it('reports no-change when failures stay same', () => {
    const history = [
      makeSnap('2024-01-01', [{ pkg: 'a', task: 'test', ok: false }]),
      makeSnap('2024-01-02', [{ pkg: 'a', task: 'test', ok: false }]),
    ];
    const result = analyzeTrends(history);
    const trend = result.tasks.find(t => t.task === 'test')!;
    expect(trend.direction).toBe('no-change');
  });

  it('builds changelog with new failures and fixed', () => {
    const history = [
      makeSnap('t1', [{ pkg: 'a', task: 'lint', ok: true }, { pkg: 'b', task: 'lint', ok: false }]),
      makeSnap('t2', [{ pkg: 'a', task: 'lint', ok: false }, { pkg: 'b', task: 'lint', ok: true }]),
    ];
    const result = analyzeTrends(history);
    const trend = result.tasks.find(t => t.task === 'lint')!;
    expect(trend.changelog).toHaveLength(1);
    expect(trend.changelog[0]!.newFailures).toContain('a');
    expect(trend.changelog[0]!.fixed).toContain('b');
  });

  it('respects window parameter', () => {
    const history = Array.from({ length: 20 }, (_, i) =>
      makeSnap(`2024-01-${String(i + 1).padStart(2, '0')}`, [{ pkg: 'a', task: 'build', ok: true }])
    );
    const result = analyzeTrends(history, 5);
    expect(result.window).toBe(5);
  });

  it('calculates velocity as average delta per changelog entry', () => {
    const history = [
      makeSnap('t1', [{ pkg: 'a', task: 'lint', ok: true }]),
      makeSnap('t2', [{ pkg: 'a', task: 'lint', ok: false }]),
      makeSnap('t3', [{ pkg: 'a', task: 'lint', ok: false }]),
    ];
    const result = analyzeTrends(history);
    const trend = result.tasks.find(t => t.task === 'lint')!;
    expect(trend.velocity).toBeGreaterThan(0);
  });
});
