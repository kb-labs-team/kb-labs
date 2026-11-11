import type { RunSnapshot, CheckSnapshot, StatsSnapshot } from '../../contracts/index.js';

export function buildRunJsonReport(snap: RunSnapshot): object {
  return {
    id: snap.id,
    timestamp: snap.timestamp,
    git: snap.git,
    durationMs: snap.durationMs,
    tasks: snap.tasks,
    ok: snap.raw.ok,
    elapsed: snap.raw.elapsed,
    summary: snap.raw.summary,
    results: snap.raw.results,
  };
}

export function buildCheckJsonReport(snap: CheckSnapshot): object {
  return {
    id: snap.id,
    timestamp: snap.timestamp,
    git: snap.git,
    durationMs: snap.durationMs,
    ok: snap.raw.ok,
    packages: snap.raw.packages,
  };
}

export function buildStatsJsonReport(snap: StatsSnapshot): object {
  return {
    id: snap.id,
    timestamp: snap.timestamp,
    git: snap.git,
    durationMs: snap.durationMs,
    ok: snap.raw.ok,
    score: snap.raw.score,
    grade: snap.raw.grade,
    summary: snap.raw.summary,
    by_category: snap.raw.by_category,
    issues_by_type: snap.raw.issues_by_type,
    coverage: snap.raw.coverage,
  };
}
