import { describe, it, expect } from 'vitest';
import { runBenchmark } from '../../../docs/core/benchmarks/harness';
import baseline from '../../../docs/core/benchmarks/baseline.json';

/**
 * Regression gate: benchmark metrics must not drop below the frozen baseline
 * (minus tolerance). Catches regressions in fusion/rerank/dedup/verify logic.
 * To intentionally move the baseline, re-run the measurement and update
 * benchmarks/baseline.json deliberately.
 */
describe('benchmark — regression gate', () => {
  it('meets or exceeds the frozen baseline on every metric', async () => {
    const report = await runBenchmark();
    const tol = baseline.tolerance.default;

    for (const [metric, base] of Object.entries(baseline.metrics)) {
      const current = report.metrics[metric as keyof typeof report.metrics];
      expect(current, `${metric} regressed (baseline ${base}, got ${current})`).toBeGreaterThanOrEqual(
        base - tol,
      );
    }
  });

  it('every non-abstain query retrieves its relevant file in the top 5', async () => {
    const report = await runBenchmark();
    const misses = report.perQuery.filter((p) => p.hit5 === 0).map((p) => p.id);
    expect(misses, `queries missing relevant doc in top-5: ${misses.join(', ')}`).toEqual([]);
  });
});
