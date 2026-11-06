import type { RunSnapshot, RegressionDetection, RunRegression } from '../../contracts/index.js';

export function detectRegressions(history: RunSnapshot[]): RegressionDetection {
  if (history.length < 2) {
    return {
      hasRegressions: false,
      regressions: [],
      comparedAt: { previous: '', current: '' },
    };
  }

  const prev = history[history.length - 2]!;
  const curr = history[history.length - 1]!;

  const allTasks = new Set([
    ...prev.raw.results.map(r => r.Task),
    ...curr.raw.results.map(r => r.Task),
  ]);

  const regressions: RunRegression[] = [];

  for (const task of allTasks) {
    const prevFailed = new Set(
      prev.raw.results.filter(r => r.Task === task && !r.OK && !r.Cached).map(r => r.Package)
    );
    const currFailed = curr.raw.results
      .filter(r => r.Task === task && !r.OK && !r.Cached)
      .map(r => r.Package);
    const newFailures = currFailed.filter(p => !prevFailed.has(p));
    if (newFailures.length > 0) {
      regressions.push({
        task,
        delta: currFailed.length - prevFailed.size,
        newFailures,
      });
    }
  }

  return {
    hasRegressions: regressions.length > 0,
    regressions,
    comparedAt: { previous: prev.timestamp, current: curr.timestamp },
  };
}
