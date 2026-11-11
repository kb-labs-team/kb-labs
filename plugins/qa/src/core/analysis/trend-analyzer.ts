import type {
  RunSnapshot,
  TaskTrend,
  TaskTrendPoint,
  TaskTrendChangelog,
  TrendAnalysis,
} from '../../contracts/index.js';
import { TRENDS_WINDOW } from '../../contracts/index.js';

function extractFailed(snap: RunSnapshot, task: string): string[] {
  return snap.raw.results
    .filter(r => r.Task === task && !r.OK && !r.Cached)
    .map(r => r.Package);
}

function collectTasks(snapshots: RunSnapshot[]): string[] {
  const s = new Set<string>();
  for (const snap of snapshots) {
    for (const r of snap.raw.results) {s.add(r.Task);}
  }
  return [...s];
}

function buildTimeSeries(snapshots: RunSnapshot[], task: string): TaskTrendPoint[] {
  return snapshots.map(snap => {
    const results = snap.raw.results.filter(r => r.Task === task);
    const failed = results.filter(r => !r.OK && !r.Cached).length;
    const cached = results.filter(r => r.Cached).length;
    const passed = results.filter(r => r.OK && !r.Cached).length;
    return {
      timestamp:  snap.timestamp,
      gitCommit:  snap.git?.commit ?? 'unknown',
      gitBranch:  snap.git?.branch ?? 'unknown',
      gitMessage: snap.git?.message ?? '',
      failed,
      cached,
      passed,
      total: results.length,
    };
  });
}

function buildChangelog(snapshots: RunSnapshot[], task: string): TaskTrendChangelog[] {
  const changelog: TaskTrendChangelog[] = [];
  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i - 1]!;
    const curr = snapshots[i]!;
    const prevFailed = new Set(extractFailed(prev, task));
    const currFailed = extractFailed(curr, task);
    const currFailedSet = new Set(currFailed);
    const newFailures = currFailed.filter(p => !prevFailed.has(p));
    const fixed = [...prevFailed].filter(p => !currFailedSet.has(p));
    const delta = currFailed.length - prevFailed.size;
    if (newFailures.length > 0 || fixed.length > 0) {
      changelog.push({
        timestamp:  curr.timestamp,
        gitCommit:  curr.git?.commit ?? 'unknown',
        gitMessage: curr.git?.message ?? '',
        newFailures,
        fixed,
        delta,
      });
    }
  }
  return changelog;
}

export function analyzeTrends(
  history: RunSnapshot[],
  window: number = TRENDS_WINDOW,
): TrendAnalysis {
  if (history.length < 2) {
    return { window, historyCount: history.length, tasks: [] };
  }

  const windowSnaps = history.slice(-window);
  const first = windowSnaps[0]!;
  const last = windowSnaps[windowSnaps.length - 1]!;
  const tasks = collectTasks(windowSnaps);

  const taskTrends: TaskTrend[] = tasks.map(task => {
    const timeSeries = buildTimeSeries(windowSnaps, task);
    const changelog = buildChangelog(windowSnaps, task);
    const previous = extractFailed(first, task).length;
    const current = extractFailed(last, task).length;
    const delta = current - previous;
    const deltas = changelog.map(c => c.delta);
    const velocity = deltas.length > 0
      ? Math.round((deltas.reduce((s, d) => s + d, 0) / deltas.length) * 100) / 100
      : 0;
    const direction: TaskTrend['direction'] =
      delta > 0 ? 'regression' : delta < 0 ? 'improvement' : 'no-change';
    return { task, previous, current, delta, direction, velocity, timeSeries, changelog };
  });

  return { window, historyCount: history.length, tasks: taskTrends };
}
