import type {
  DevkitRunOutput,
  DevkitCheckOutput,
  DevkitStatsOutput,
  DevkitGateOutput,
} from './devkit.js';

export interface SnapshotGit {
  commit: string;
  branch: string;
  message: string;
}

export interface SnapshotMeta {
  id: string;
  timestamp: string;
  git?: SnapshotGit;
  durationMs: number;
  runContext?: Record<string, unknown>;
}

export interface RunSnapshot extends SnapshotMeta {
  kind: 'run';
  tasks: string[];
  raw: DevkitRunOutput;
}

export interface CheckSnapshot extends SnapshotMeta {
  kind: 'check';
  raw: DevkitCheckOutput;
}

export interface StatsSnapshot extends SnapshotMeta {
  kind: 'stats';
  raw: DevkitStatsOutput;
}

export interface GateSnapshot extends SnapshotMeta {
  kind: 'gate';
  raw: DevkitGateOutput;
}

export type E2eErrorCategory = 'infra-timeout' | 'assertion-race' | 'ws-flake' | 'unknown';

export interface E2eCaseAttempt {
  status: 'passed' | 'failed';
  retry: number;
  durationMs: number;
  errorCategory?: E2eErrorCategory;
  errorMessage?: string;
}

/** A pointer to the per-run CI dossier; raw evidence stays in CI artifacts. */
export interface E2eEvidenceRef {
  runId: string;
  path: string;
  summaryPath?: string;
  manifestPath?: string;
}

export interface E2eCaseResult {
  suite: string;
  spec: string;
  testId: string;
  title: string;
  outcome: 'passed' | 'flaky' | 'failed' | 'skipped';
  attempts: E2eCaseAttempt[];
  evidence?: E2eEvidenceRef;
}

export interface E2eFlakySnapshot extends SnapshotMeta {
  kind: 'e2e-flaky';
  cases: E2eCaseResult[];
}

export type AnySnapshot = RunSnapshot | CheckSnapshot | StatsSnapshot | GateSnapshot | E2eFlakySnapshot;

export interface BaselineData {
  timestamp: string;
  git?: SnapshotGit;
  check: DevkitCheckOutput;
  stats: DevkitStatsOutput;
}
