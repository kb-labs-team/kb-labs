import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SnapshotStore } from '../../src/core/snapshot/snapshot-store.js';
import type { DevkitRunOutput, DevkitCheckOutput, DevkitStatsOutput, DevkitGateOutput } from '@kb-labs/qa/contracts';

const makeRun = (ok = true): DevkitRunOutput => ({
  elapsed: '1s',
  ok,
  results: [{ Package: 'pkg-a', Task: 'build', OK: ok, Cached: false, Elapsed: 100, ExitCode: ok ? 0 : 1, Stdout: '', Stderr: '', Error: '' }],
  summary: { total: 1, passed: ok ? 1 : 0, failed: ok ? 0 : 1, cached: 0 },
});

const makeCheck = (ok = true): DevkitCheckOutput => ({
  ok,
  packages: {
    'pkg-a': {
      ok,
      issues: ok ? [] : [{ check: 'readme', severity: 'error', message: 'missing README' }],
    },
  },
});

const makeStats = (score = 88): DevkitStatsOutput => ({
  ok: true,
  score,
  grade: score >= 90 ? 'A' : 'B',
  summary: { total: 5, healthy: 4, warning: 1, error: 0, total_errors: 0, total_warnings: 2 },
  by_category: {},
  issues_by_type: {},
  coverage: {},
});

const makeGate = (ok = true): DevkitGateOutput => ({
  ok,
  staged_files: 3,
  violations: ok ? [] : [{ package: 'pkg-a', check: 'lint', severity: 'error', message: 'fail' }],
});

let rootDir: string;

beforeEach(() => {
  rootDir = join(tmpdir(), `qa-test-${Date.now()}`);
  mkdirSync(rootDir, { recursive: true });
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

describe('SnapshotStore — run snapshots', () => {
  it('saves and loads a run snapshot', () => {
    const store = new SnapshotStore(rootDir);
    const snap = store.saveRun(makeRun(), ['build'], 500);
    expect(snap.kind).toBe('run');
    expect(snap.tasks).toEqual(['build']);
    expect(snap.raw.ok).toBe(true);

    const history = store.loadRunHistory();
    expect(history).toHaveLength(1);
    expect(history[0]!.id).toBe(snap.id);
  });

  it('trims run history to maxEntries', () => {
    const store = new SnapshotStore(rootDir, 3);
    for (let i = 0; i < 5; i++) {store.saveRun(makeRun(), ['lint'], 100);}
    expect(store.loadRunHistory()).toHaveLength(3);
  });

  it('latestRun returns most recent entry', () => {
    const store = new SnapshotStore(rootDir);
    store.saveRun(makeRun(true), ['build'], 100);
    const last = store.saveRun(makeRun(false), ['build'], 200);
    expect(store.latestRun()!.id).toBe(last.id);
    expect(store.latestRun()!.raw.ok).toBe(false);
  });

  it('latestRun returns null when empty', () => {
    expect(new SnapshotStore(rootDir).latestRun()).toBeNull();
  });

  it('attaches git context when provided', () => {
    const store = new SnapshotStore(rootDir);
    const git = { commit: 'abc123', branch: 'main', message: 'feat: stuff' };
    const snap = store.saveRun(makeRun(), ['build'], 100, git);
    expect(snap.git).toEqual(git);
    expect(store.loadRunHistory()[0]!.git).toEqual(git);
  });
});

describe('SnapshotStore — check snapshots', () => {
  it('saves and retrieves check snapshot', () => {
    const store = new SnapshotStore(rootDir);
    const snap = store.saveCheck(makeCheck(false), 300);
    expect(snap.kind).toBe('check');
    expect(snap.raw.ok).toBe(false);
    expect(store.latestCheck()!.id).toBe(snap.id);
  });

  it('trims check history', () => {
    const store = new SnapshotStore(rootDir, 2);
    for (let i = 0; i < 4; i++) {store.saveCheck(makeCheck(), 100);}
    expect(store.loadCheckHistory()).toHaveLength(2);
  });
});

describe('SnapshotStore — stats snapshots', () => {
  it('saves and retrieves stats snapshot', () => {
    const store = new SnapshotStore(rootDir);
    const snap = store.saveStats(makeStats(95), 200);
    expect(snap.raw.score).toBe(95);
    expect(store.latestStats()!.id).toBe(snap.id);
  });
});

describe('SnapshotStore — gate snapshots', () => {
  it('saves gate snapshot', () => {
    const store = new SnapshotStore(rootDir);
    const snap = store.saveGate(makeGate(false), 50);
    expect(snap.raw.ok).toBe(false);
    expect(snap.raw.violations).toHaveLength(1);
  });
});

describe('SnapshotStore — baseline', () => {
  it('returns null when no baseline exists', () => {
    expect(new SnapshotStore(rootDir).loadBaseline()).toBeNull();
  });

  it('saves and loads baseline', () => {
    const store = new SnapshotStore(rootDir);
    const b = store.saveBaseline(makeCheck(), makeStats(82));
    expect(b.stats.score).toBe(82);
    expect(store.loadBaseline()!.stats.score).toBe(82);
  });

  it('overwrites previous baseline', () => {
    const store = new SnapshotStore(rootDir);
    store.saveBaseline(makeCheck(), makeStats(70));
    store.saveBaseline(makeCheck(), makeStats(90));
    expect(store.loadBaseline()!.stats.score).toBe(90);
  });
});
