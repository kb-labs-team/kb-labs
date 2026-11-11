import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  SNAPSHOT_DIR,
  SNAPSHOT_FILE,
  MAX_SNAPSHOTS_DEFAULT,
} from '../../contracts/index.js';
import type {
  QualitySnapshot,
  SnapshotDelta,
  SnapshotHistory,
} from '../../contracts/index.js';

function readSnapshots(filePath: string): QualitySnapshot[] {
  if (!existsSync(filePath)) {return [];}
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as QualitySnapshot[];
  } catch {
    return [];
  }
}

function writeSnapshots(filePath: string, data: QualitySnapshot[]): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {mkdirSync(dir, { recursive: true });}
  writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function computeDelta(current: QualitySnapshot, previous: QualitySnapshot): SnapshotDelta {
  return {
    score: current.score - previous.score,
    layeringViolations: current.counters.layeringViolations - previous.counters.layeringViolations,
    anyCount: current.counters.anyCount - previous.counters.anyCount,
    tsIgnoreCount: current.counters.tsIgnoreCount - previous.counters.tsIgnoreCount,
    unusedFiles: current.counters.unusedFiles - previous.counters.unusedFiles,
    unusedDeps: current.counters.unusedDeps - previous.counters.unusedDeps,
    avgInstability: Math.round((current.counters.avgInstability - previous.counters.avgInstability) * 100) / 100,
  };
}

export interface SnapshotInput {
  score: number;
  grade: QualitySnapshot['grade'];
  dimensions: QualitySnapshot['dimensions'];
  counters: QualitySnapshot['counters'];
  git: QualitySnapshot['git'];
}

export class QualitySnapshotStore {
  private readonly snapshotPath: string;
  private readonly maxEntries: number;

  constructor(rootDir: string, maxEntries = MAX_SNAPSHOTS_DEFAULT) {
    this.snapshotPath = join(rootDir, SNAPSHOT_DIR, SNAPSHOT_FILE);
    this.maxEntries = maxEntries;
  }

  load(): QualitySnapshot[] {
    return readSnapshots(this.snapshotPath);
  }

  save(input: SnapshotInput): QualitySnapshot {
    const snap: QualitySnapshot = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      ...input,
    };

    const history = this.load();
    history.push(snap);
    while (history.length > this.maxEntries) {history.shift();}
    writeSnapshots(this.snapshotPath, history);
    return snap;
  }

  latest(): QualitySnapshot | null {
    const h = this.load();
    return h.length > 0 ? (h[h.length - 1] ?? null) : null;
  }

  history(): SnapshotHistory {
    const snapshots = this.load();
    const latest = snapshots.length > 0 ? (snapshots[snapshots.length - 1] ?? null) : null;
    const previous = snapshots.length > 1 ? (snapshots[snapshots.length - 2] ?? null) : null;
    const delta = latest && previous ? computeDelta(latest, previous) : null;
    return { snapshots, delta, latest };
  }
}
