import { z } from 'zod';

// ── Shared schemas ────────────────────────────────────────────────────────────

export const SnapshotGitSchema = z.object({
  commit: z.string(),
  branch: z.string(),
  message: z.string(),
});

export const SnapshotMetaSchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  git: SnapshotGitSchema.optional(),
  durationMs: z.number(),
  runContext: z.record(z.unknown()).optional(),
});

// DevkitRunOutput
export const DevkitRunResultSchema = z.object({
  Package: z.string(),
  Task: z.string(),
  OK: z.boolean(),
  Cached: z.boolean(),
  Elapsed: z.number(),
  ExitCode: z.number(),
  Stdout: z.string(),
  Stderr: z.string(),
  Error: z.string(),
});

export const DevkitRunOutputSchema = z.object({
  elapsed: z.string(),
  ok: z.boolean(),
  results: z.array(DevkitRunResultSchema),
  summary: z.object({
    total: z.number(),
    passed: z.number(),
    failed: z.number(),
    cached: z.number(),
  }),
});

// DevkitCheckOutput
export const DevkitCheckIssueSchema = z.object({
  check: z.string(),
  severity: z.enum(['error', 'warning', 'info']),
  message: z.string(),
  file: z.string().optional(),
  fix: z.string().optional(),
  capability: z.string().optional(),
});

export const DevkitCheckOutputSchema = z.object({
  ok: z.boolean(),
  packages: z.record(z.object({
    ok: z.boolean(),
    issues: z.array(DevkitCheckIssueSchema).nullable(),
  })),
});

// DevkitStatsOutput
export const DevkitStatsOutputSchema = z.object({
  ok: z.boolean(),
  score: z.number(),
  grade: z.string(),
  summary: z.object({
    total: z.number(),
    healthy: z.number(),
    warning: z.number(),
    error: z.number(),
    total_errors: z.number(),
    total_warnings: z.number(),
  }),
  by_category: z.record(z.object({
    total: z.number(),
    healthy: z.number(),
    issues: z.number(),
    grade: z.string(),
  })),
  issues_by_type: z.record(z.object({
    check: z.string(),
    errors: z.number(),
    warnings: z.number(),
    packages: z.number(),
  })),
  coverage: z.record(z.object({
    pass: z.number(),
    total: z.number(),
    pct: z.number(),
  })),
});

// DevkitGateOutput
export const DevkitGateOutputSchema = z.object({
  ok: z.boolean(),
  staged_files: z.number(),
  violations: z.array(z.object({
    package: z.string(),
    check: z.string(),
    severity: z.string(),
    message: z.string(),
  })),
});

// ── Snapshot schemas ──────────────────────────────────────────────────────────

export const RunSnapshotSchema = SnapshotMetaSchema.extend({
  kind: z.literal('run'),
  tasks: z.array(z.string()),
  raw: DevkitRunOutputSchema,
});

export const CheckSnapshotSchema = SnapshotMetaSchema.extend({
  kind: z.literal('check'),
  raw: DevkitCheckOutputSchema,
});

export const StatsSnapshotSchema = SnapshotMetaSchema.extend({
  kind: z.literal('stats'),
  raw: DevkitStatsOutputSchema,
});

export const GateSnapshotSchema = SnapshotMetaSchema.extend({
  kind: z.literal('gate'),
  raw: DevkitGateOutputSchema,
});

export const BaselineDataSchema = z.object({
  timestamp: z.string(),
  git: SnapshotGitSchema.optional(),
  check: DevkitCheckOutputSchema,
  stats: DevkitStatsOutputSchema,
});

// ── Analysis schemas ──────────────────────────────────────────────────────────

export const BaselineCheckDiffSchema = z.object({
  newIssues: z.array(z.object({
    pkg: z.string(),
    check: z.string(),
    status: z.enum(['new', 'fixed', 'persisting']),
    severity: z.string(),
    message: z.string(),
  })),
  fixedIssues: z.array(z.object({
    pkg: z.string(),
    check: z.string(),
    status: z.enum(['new', 'fixed', 'persisting']),
    severity: z.string(),
    message: z.string(),
  })),
  persistingIssues: z.array(z.object({
    pkg: z.string(),
    check: z.string(),
    status: z.enum(['new', 'fixed', 'persisting']),
    severity: z.string(),
    message: z.string(),
  })),
  newIssueCount: z.number(),
  fixedIssueCount: z.number(),
  scoreDelta: z.number(),
  gradeDelta: z.string(),
});

// ── Request/Response schemas ──────────────────────────────────────────────────

// GET /summary
export const QASummaryResponseSchema = z.object({
  score: z.number().nullable(),
  grade: z.string().nullable(),
  ok: z.boolean().nullable(),
  lastRunAt: z.string().nullable(),
  lastCheckAt: z.string().nullable(),
  lastStatsAt: z.string().nullable(),
  git: SnapshotGitSchema.nullable(),
  hasBaseline: z.boolean(),
  baselineTimestamp: z.string().nullable(),
  runHistoryCount: z.number(),
});
export type QASummaryResponse = z.infer<typeof QASummaryResponseSchema>;

// POST /run
export const QARunRequestSchema = z.object({
  tasks: z.array(z.string()).optional(),
  save: z.boolean().optional(),
  runContext: z.record(z.unknown()).optional(),
});
export type QARunRequest = z.infer<typeof QARunRequestSchema>;

export const QARunResponseSchema = z.object({
  ok: z.boolean(),
  snapshot: RunSnapshotSchema,
  durationMs: z.number(),
});
export type QARunResponse = z.infer<typeof QARunResponseSchema>;

// POST /check
export const QACheckRequestSchema = z.object({
  save: z.boolean().optional(),
  runContext: z.record(z.unknown()).optional(),
});
export type QACheckRequest = z.infer<typeof QACheckRequestSchema>;

export const QACheckResponseSchema = z.object({
  ok: z.boolean(),
  snapshot: CheckSnapshotSchema,
  durationMs: z.number(),
});
export type QACheckResponse = z.infer<typeof QACheckResponseSchema>;

// GET /stats
export const QAStatsResponseSchema = z.object({
  snapshot: StatsSnapshotSchema.nullable(),
});
export type QAStatsResponse = z.infer<typeof QAStatsResponseSchema>;

// POST /gate
export const QAGateRequestSchema = z.object({
  save: z.boolean().optional(),
});
export type QAGateRequest = z.infer<typeof QAGateRequestSchema>;

export const QAGateResponseSchema = z.object({
  ok: z.boolean(),
  snapshot: GateSnapshotSchema,
  durationMs: z.number(),
});
export type QAGateResponse = z.infer<typeof QAGateResponseSchema>;

// GET /history
export const QAHistoryResponseSchema = z.object({
  snapshots: z.array(RunSnapshotSchema),
  total: z.number(),
});
export type QAHistoryResponse = z.infer<typeof QAHistoryResponseSchema>;

// GET /baseline
export const QABaselineResponseSchema = z.object({
  baseline: BaselineDataSchema.nullable(),
});
export type QABaselineResponse = z.infer<typeof QABaselineResponseSchema>;

// GET /baseline/diff
export const QABaselineDiffResponseSchema = z.union([
  BaselineCheckDiffSchema,
  z.object({ error: z.enum(['no-baseline', 'no-check', 'no-stats']) }),
]);
export type QABaselineDiffResponse = z.infer<typeof QABaselineDiffResponseSchema>;
