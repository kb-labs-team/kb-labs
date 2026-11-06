// Raw JSON output shapes from kb-devkit CLI (--json flag)

// kb-devkit run <tasks> --json
export interface DevkitRunResult {
  Package: string;
  Task: string;
  OK: boolean;
  Cached: boolean;
  Elapsed: number; // nanoseconds
  ExitCode: number;
  Stdout: string;
  Stderr: string;
  Error: string;
}

export interface DevkitRunSummary {
  total: number;
  passed: number;
  failed: number;
  cached: number;
}

export interface DevkitRunOutput {
  elapsed: string;
  ok: boolean;
  results: DevkitRunResult[];
  summary: DevkitRunSummary;
}

// kb-devkit check --json
export interface DevkitCheckIssue {
  check: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  file?: string;
  fix?: string;
  capability?: string;
}

export interface DevkitCheckPackage {
  ok: boolean;
  issues: DevkitCheckIssue[] | null;
}

export interface DevkitCheckOutput {
  ok: boolean;
  packages: Record<string, DevkitCheckPackage>;
}

// kb-devkit stats --json
export interface DevkitStatsCategoryBreakdown {
  total: number;
  healthy: number;
  issues: number;
  grade: string;
}

export interface DevkitStatsIssueType {
  check: string;
  errors: number;
  warnings: number;
  packages: number;
}

export interface DevkitStatsCoverage {
  pass: number;
  total: number;
  pct: number;
}

export interface DevkitStatsSummary {
  total: number;
  healthy: number;
  warning: number;
  error: number;
  total_errors: number;
  total_warnings: number;
}

export interface DevkitStatsOutput {
  ok: boolean;
  score: number;
  grade: string;
  summary: DevkitStatsSummary;
  by_category: Record<string, DevkitStatsCategoryBreakdown>;
  issues_by_type: Record<string, DevkitStatsIssueType>;
  coverage: Record<string, DevkitStatsCoverage>;
}

// kb-devkit status --json
export interface DevkitStatusPackage {
  state: 'healthy' | 'warning' | 'error';
  category: string;
}

export interface DevkitStatusOutput {
  ok: boolean;
  packages: Record<string, DevkitStatusPackage>;
}

// kb-devkit gate --json
export interface DevkitGateViolation {
  package: string;
  check: string;
  severity: string;
  message: string;
}

export interface DevkitGateOutput {
  ok: boolean;
  staged_files: number;
  violations: DevkitGateViolation[];
}
