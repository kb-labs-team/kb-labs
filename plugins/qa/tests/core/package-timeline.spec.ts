import { describe, it, expect } from 'vitest';
import { buildPackageTimeline } from '../../src/core/analysis/package-timeline.js';
import type { RunSnapshot } from '@kb-labs/qa/contracts';

function makeSnap(ts: string, results: Array<{ pkg: string; task: string; ok: boolean; cached?: boolean }>): RunSnapshot {
  return {
    kind: 'run',
    id: ts,
    timestamp: ts,
    durationMs: 100,
    tasks: [...new Set(results.map(r => r.task))],
    raw: {
      elapsed: '1s',
      ok: results.every(r => r.ok || r.cached),
      results: results.map(r => ({
        Package: r.pkg, Task: r.task, OK: r.ok, Cached: r.cached ?? false,
        Elapsed: 10, ExitCode: r.ok ? 0 : 1, Stdout: '', Stderr: '', Error: '',
      })),
      summary: { total: results.length, passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, cached: 0 },
    },
  };
}

describe('buildPackageTimeline', () => {
  it('returns empty history for unknown package', () => {
    const history = [makeSnap('t1', [{ pkg: 'a', task: 'build', ok: true }])];
    const tl = buildPackageTimeline(history, 'unknown');
    expect(tl.history).toHaveLength(0);
    expect(tl.flakyScore).toBe(0);
  });

  it('builds history entries for the package', () => {
    const history = [
      makeSnap('t1', [{ pkg: 'a', task: 'lint', ok: true }]),
      makeSnap('t2', [{ pkg: 'a', task: 'lint', ok: false }]),
    ];
    const tl = buildPackageTimeline(history, 'a');
    expect(tl.history).toHaveLength(2);
    expect(tl.packageName).toBe('a');
  });

  it('detects flaky task when flip rate > 30%', () => {
    // 3 flips out of 4 transitions = 75% → flaky
    const history = [
      makeSnap('t1', [{ pkg: 'a', task: 'test', ok: true }]),
      makeSnap('t2', [{ pkg: 'a', task: 'test', ok: false }]),
      makeSnap('t3', [{ pkg: 'a', task: 'test', ok: true }]),
      makeSnap('t4', [{ pkg: 'a', task: 'test', ok: false }]),
      makeSnap('t5', [{ pkg: 'a', task: 'test', ok: true }]),
    ];
    const tl = buildPackageTimeline(history, 'a');
    expect(tl.flakyTasks).toContain('test');
    expect(tl.flakyScore).toBeGreaterThan(0);
  });

  it('does not mark stable task as flaky', () => {
    const history = [
      makeSnap('t1', [{ pkg: 'a', task: 'build', ok: true }]),
      makeSnap('t2', [{ pkg: 'a', task: 'build', ok: true }]),
      makeSnap('t3', [{ pkg: 'a', task: 'build', ok: true }]),
    ];
    const tl = buildPackageTimeline(history, 'a');
    expect(tl.flakyTasks).toHaveLength(0);
  });

  it('computes current streak correctly', () => {
    const history = [
      makeSnap('t1', [{ pkg: 'a', task: 'lint', ok: false }]),
      makeSnap('t2', [{ pkg: 'a', task: 'lint', ok: true }]),
      makeSnap('t3', [{ pkg: 'a', task: 'lint', ok: true }]),
    ];
    const tl = buildPackageTimeline(history, 'a');
    expect(tl.currentStreak.status).toBe('passing');
    expect(tl.currentStreak.count).toBe(2);
  });

  it('detects first failure timestamp', () => {
    const history = [
      makeSnap('2024-01-01T00:00:00.000Z', [{ pkg: 'a', task: 'build', ok: true }]),
      makeSnap('2024-01-02T00:00:00.000Z', [{ pkg: 'a', task: 'build', ok: false }]),
      makeSnap('2024-01-03T00:00:00.000Z', [{ pkg: 'a', task: 'build', ok: false }]),
    ];
    const tl = buildPackageTimeline(history, 'a');
    expect(tl.firstFailure).toBe('2024-01-02T00:00:00.000Z');
  });

  it('excludes cached results from streak and flaky calculation', () => {
    const history = [
      makeSnap('t1', [{ pkg: 'a', task: 'test', ok: false }]),
      makeSnap('t2', [{ pkg: 'a', task: 'test', ok: true, cached: true }]),
      makeSnap('t3', [{ pkg: 'a', task: 'test', ok: false }]),
    ];
    const tl = buildPackageTimeline(history, 'a');
    // Cached entries should not count as status flips
    const testHistory = tl.history.filter(e => e.task === 'test' && e.status !== 'cached');
    expect(testHistory.every(e => e.status === 'failed')).toBe(true);
  });
});
