import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  PATHS,
  HISTORY_MAX_ENTRIES,
} from '../../contracts/index.js';
import type {
  RunSnapshot,
  CheckSnapshot,
  StatsSnapshot,
  GateSnapshot,
  E2eFlakySnapshot,
  E2eCaseResult,
  SnapshotMeta,
  SnapshotGit,
  BaselineData,
  DevkitRunOutput,
  DevkitCheckOutput,
  DevkitStatsOutput,
  DevkitGateOutput,
} from '../../contracts/index.js';

function readJson<T>(filePath: string): T[] {
  if (!existsSync(filePath)) {return [];}
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T[];
  } catch {
    return [];
  }
}

function writeJson(filePath: string, data: unknown): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {mkdirSync(dir, { recursive: true });}
  writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function buildMeta(
  durationMs: number,
  git?: SnapshotGit,
  runContext?: Record<string, unknown>,
): SnapshotMeta {
  return {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    durationMs,
    ...(git ? { git } : {}),
    ...(runContext ? { runContext } : {}),
  };
}

export class SnapshotStore {
  private readonly rootDir: string;
  private readonly maxEntries: number;

  constructor(rootDir: string, maxEntries = HISTORY_MAX_ENTRIES) {
    this.rootDir = rootDir;
    this.maxEntries = maxEntries;
  }

  // ── Run snapshots ──────────────────────────────────────────────────────────

  loadRunHistory(): RunSnapshot[] {
    return readJson<RunSnapshot>(join(this.rootDir, PATHS.SNAPSHOTS_RUN));
  }

  saveRun(
    raw: DevkitRunOutput,
    tasks: string[],
    durationMs: number,
    git?: SnapshotGit,
    runContext?: Record<string, unknown>,
  ): RunSnapshot {
    const snap: RunSnapshot = {
      ...buildMeta(durationMs, git, runContext),
      kind: 'run',
      tasks,
      raw,
    };
    const history = this.loadRunHistory();
    history.push(snap);
    while (history.length > this.maxEntries) {history.shift();}
    writeJson(join(this.rootDir, PATHS.SNAPSHOTS_RUN), history);
    return snap;
  }

  latestRun(): RunSnapshot | null {
    const h = this.loadRunHistory();
    return h.length > 0 ? h[h.length - 1]! : null;
  }

  // ── Check snapshots ────────────────────────────────────────────────────────

  loadCheckHistory(): CheckSnapshot[] {
    return readJson<CheckSnapshot>(join(this.rootDir, PATHS.SNAPSHOTS_CHECK));
  }

  saveCheck(
    raw: DevkitCheckOutput,
    durationMs: number,
    git?: SnapshotGit,
    runContext?: Record<string, unknown>,
  ): CheckSnapshot {
    const snap: CheckSnapshot = {
      ...buildMeta(durationMs, git, runContext),
      kind: 'check',
      raw,
    };
    const history = this.loadCheckHistory();
    history.push(snap);
    while (history.length > this.maxEntries) {history.shift();}
    writeJson(join(this.rootDir, PATHS.SNAPSHOTS_CHECK), history);
    return snap;
  }

  latestCheck(): CheckSnapshot | null {
    const h = this.loadCheckHistory();
    return h.length > 0 ? h[h.length - 1]! : null;
  }

  // ── Stats snapshots ────────────────────────────────────────────────────────

  loadStatsHistory(): StatsSnapshot[] {
    return readJson<StatsSnapshot>(join(this.rootDir, PATHS.SNAPSHOTS_STATS));
  }

  saveStats(
    raw: DevkitStatsOutput,
    durationMs: number,
    git?: SnapshotGit,
    runContext?: Record<string, unknown>,
  ): StatsSnapshot {
    const snap: StatsSnapshot = {
      ...buildMeta(durationMs, git, runContext),
      kind: 'stats',
      raw,
    };
    const history = this.loadStatsHistory();
    history.push(snap);
    while (history.length > this.maxEntries) {history.shift();}
    writeJson(join(this.rootDir, PATHS.SNAPSHOTS_STATS), history);
    return snap;
  }

  latestStats(): StatsSnapshot | null {
    const h = this.loadStatsHistory();
    return h.length > 0 ? h[h.length - 1]! : null;
  }

  // ── Gate snapshots ─────────────────────────────────────────────────────────

  loadGateHistory(): GateSnapshot[] {
    return readJson<GateSnapshot>(join(this.rootDir, PATHS.SNAPSHOTS_GATE));
  }

  saveGate(
    raw: DevkitGateOutput,
    durationMs: number,
    git?: SnapshotGit,
    runContext?: Record<string, unknown>,
  ): GateSnapshot {
    const snap: GateSnapshot = {
      ...buildMeta(durationMs, git, runContext),
      kind: 'gate',
      raw,
    };
    const history = this.loadGateHistory();
    history.push(snap);
    while (history.length > this.maxEntries) {history.shift();}
    writeJson(join(this.rootDir, PATHS.SNAPSHOTS_GATE), history);
    return snap;
  }

  // ── E2E flaky snapshots ───────────────────────────────────────────────────────

  loadE2eFlakyHistory(): E2eFlakySnapshot[] {
    return readJson<E2eFlakySnapshot>(join(this.rootDir, PATHS.SNAPSHOTS_E2E_FLAKY));
  }

  saveE2eFlaky(
    cases: E2eCaseResult[],
    durationMs: number,
    git?: SnapshotGit,
    runContext?: Record<string, unknown>,
  ): E2eFlakySnapshot {
    const snap: E2eFlakySnapshot = {
      ...buildMeta(durationMs, git, runContext),
      kind: 'e2e-flaky',
      cases,
    };
    const history = this.loadE2eFlakyHistory();
    history.push(snap);
    while (history.length > this.maxEntries) {history.shift();}
    writeJson(join(this.rootDir, PATHS.SNAPSHOTS_E2E_FLAKY), history);
    return snap;
  }

  latestE2eFlaky(): E2eFlakySnapshot | null {
    const h = this.loadE2eFlakyHistory();
    return h.length > 0 ? h[h.length - 1]! : null;
  }

  // ── Baseline ───────────────────────────────────────────────────────────────

  loadBaseline(): BaselineData | null {
    const p = join(this.rootDir, PATHS.BASELINE);
    if (!existsSync(p)) {return null;}
    try {
      return JSON.parse(readFileSync(p, 'utf-8')) as BaselineData;
    } catch {
      return null;
    }
  }

  saveBaseline(
    check: DevkitCheckOutput,
    stats: DevkitStatsOutput,
    git?: SnapshotGit,
  ): BaselineData {
    const baseline: BaselineData = {
      timestamp: new Date().toISOString(),
      ...(git ? { git } : {}),
      check,
      stats,
    };
    writeJson(join(this.rootDir, PATHS.BASELINE), baseline);
    return baseline;
  }
}
