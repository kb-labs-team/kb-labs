/** Provider-neutral evidence produced for one CI workflow run. */
export interface CiRunDossier {
  schemaVersion: 1;
  provider: 'github-actions';
  collectedAt: string;
  collectionStatus: 'complete' | 'partial';
  run: CiRunRef;
  workflow: CiWorkflowRef;
  jobs: CiJobEvidence[];
  sourceRefs: CiSourceRef[];
}

export interface CiRunRef {
  id: string;
  attempt: number;
  event: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  headSha: string;
  headBranch: string | null;
  htmlUrl: string;
}

export interface CiWorkflowRef {
  name: string;
  path?: string;
  sha?: string;
}

export interface CiJobEvidence {
  id: string;
  name: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  runner?: { name?: string; group?: string; os?: string };
  steps: CiStepEvidence[];
  failure?: CiFailureEvidence;
  htmlUrl: string;
}

export interface CiStepEvidence {
  number: number;
  name: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string |null;
  durationMs: number | null;
}

export interface CiFailureEvidence {
  phase: 'setup' | 'build' | 'test' | 'publish' | 'unknown';
  fingerprint: string;
  summary: string;
  excerpt?: string;
  confidence: number;
}

export interface CiSourceRef {
  kind: 'run' | 'job-log' | 'artifact';
  url: string;
  label: string;
}

export interface CiReliabilityFinding {
  fingerprint: string;
  phase: CiFailureEvidence['phase'];
  summary: string;
  confidence: number;
  occurrences: number;
  affectedJobs: string[];
  sampleRunIds: string[];
  firstSeenAt: string;
  lastSeenAt: string;
}

/** Compact, agent-ready result. It deliberately links to evidence instead of embedding logs. */
export interface CiReliabilityOverview {
  schemaVersion: 1;
  generatedAt: string;
  runsAnalyzed: number;
  failedRuns: number;
  failedBeforeTests: number;
  collection: { complete: number; partial: number };
  findings: CiReliabilityFinding[];
  drillDown: { runIds: string[] };
}

export interface CiEvidenceSyncResult {
  requestedRuns: number;
  downloadedRunIds: string[];
  cachedRunIds: string[];
  unavailableRunIds: string[];
}
