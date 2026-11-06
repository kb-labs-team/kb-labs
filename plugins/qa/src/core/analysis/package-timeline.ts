import type { RunSnapshot, PackageTimeline, PackageTaskHistory } from '../../contracts/index.js';

export function buildPackageTimeline(
  history: RunSnapshot[],
  packageName: string,
): PackageTimeline {
  const entries: PackageTaskHistory[] = [];

  for (const snap of [...history].reverse()) {
    for (const r of snap.raw.results.filter(r => r.Package === packageName)) {
      entries.push({
        timestamp: snap.timestamp,
        gitCommit: snap.git?.commit ?? 'unknown',
        task:      r.Task,
        status:    r.Cached ? 'cached' : r.OK ? 'passed' : 'failed',
      });
    }
  }

  const taskNames = [...new Set(entries.map(e => e.task))];
  let totalFlips = 0;
  let totalTransitions = 0;
  const flakyTasks: string[] = [];

  for (const task of taskNames) {
    const taskEntries = entries.filter(e => e.task === task && e.status !== 'cached');
    let flips = 0;
    for (let i = 1; i < taskEntries.length; i++) {
      totalTransitions++;
      if (taskEntries[i]!.status !== taskEntries[i - 1]!.status) {
        flips++;
        totalFlips++;
      }
    }
    if (taskEntries.length > 1 && flips / (taskEntries.length - 1) > 0.3) {
      flakyTasks.push(task);
    }
  }

  const flakyScore = totalTransitions > 0
    ? Math.round((totalFlips / totalTransitions) * 100) / 100
    : 0;

  const latest = entries[0];
  let streakStatus: 'passing' | 'failing' = 'passing';
  let streakCount = 0;

  if (latest) {
    streakStatus = latest.status === 'failed' ? 'failing' : 'passing';
    streakCount = 1;
    for (let i = 1; i < entries.length; i++) {
      const s = entries[i]!.status === 'failed' ? 'failing' : 'passing';
      if (s !== streakStatus) {break;}
      streakCount++;
    }
  }

  let firstFailure: string | undefined;
  for (const e of [...entries].reverse()) {
    if (e.status === 'failed') {
      firstFailure = e.timestamp;
      break;
    }
  }

  return {
    packageName,
    history: entries,
    flakyScore,
    flakyTasks,
    currentStreak: { status: streakStatus, count: streakCount },
    firstFailure,
  };
}
