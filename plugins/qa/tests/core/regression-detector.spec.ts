import { describe, it, expect } from 'vitest';
import { detectRegressions } from '../../src/core/analysis/regression-detector.js';
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
      summary: { total: results.length, passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, cached: 0 },
    },
  };
}

describe('detectRegressions', () => {
  it('returns no regressions for < 2 snapshots', () => {
    const result = detectRegressions([makeSnap('t1', [])]);
    expect(result.hasRegressions).toBe(false);
    expect(result.regressions).toHaveLength(0);
  });

  it('detects new failures vs previous run', () => {
    const history = [
      makeSnap('t1', [{ pkg: 'a', task: 'lint', ok: true }, { pkg: 'b', task: 'lint', ok: true }]),
      makeSnap('t2', [{ pkg: 'a', task: 'lint', ok: false }, { pkg: 'b', task: 'lint', ok: true }]),
    ];
    const result = detectRegressions(history);
    expect(result.hasRegressions).toBe(true);
    expect(result.regressions).toHaveLength(1);
    expect(result.regressions[0]!.task).toBe('lint');
    expect(result.regressions[0]!.newFailures).toContain('a');
    expect(result.regressions[0]!.newFailures).not.toContain('b');
  });

  it('does not flag already-failing packages as regressions', () => {
    const history = [
      makeSnap('t1', [{ pkg: 'a', task: 'build', ok: false }]),
      makeSnap('t2', [{ pkg: 'a', task: 'build', ok: false }]),
    ];
    const result = detectRegressions(history);
    expect(result.hasRegressions).toBe(false);
  });

  it('sets comparedAt timestamps', () => {
    const history = [
      makeSnap('2024-01-01T00:00:00.000Z', [{ pkg: 'a', task: 'test', ok: true }]),
      makeSnap('2024-01-02T00:00:00.000Z', [{ pkg: 'a', task: 'test', ok: false }]),
    ];
    const result = detectRegressions(history);
    expect(result.comparedAt.previous).toBe('2024-01-01T00:00:00.000Z');
    expect(result.comparedAt.current).toBe('2024-01-02T00:00:00.000Z');
  });

  it('compares only last two snapshots regardless of history length', () => {
    const history = [
      makeSnap('t1', [{ pkg: 'a', task: 'lint', ok: false }]),
      makeSnap('t2', [{ pkg: 'a', task: 'lint', ok: true }]),
      makeSnap('t3', [{ pkg: 'a', task: 'lint', ok: true }]),
    ];
    // t2→t3: a was passing → passing, no regression
    const result = detectRegressions(history);
    expect(result.hasRegressions).toBe(false);
  });
});
