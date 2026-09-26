/**
 * ReleaseRunReport — one artifact per run (09 §3.2), built purely from
 * existing CheckResult data. Visibility only: it never changes pass/fail.
 */

import { basename } from 'node:path';
import type { CheckResult, CheckResultDetails } from '../types';
import { classifyFailure, type FailureClassification } from './classify';
import { createReleaseError, type ReleaseErrorEnvelope } from './error-codes';
import { preflightCommand, type PreflightResult } from './preflight';

export type StageStatus = 'passed' | 'failed' | 'skipped' | 'not-run';

export interface StageRow {
  stage: string;
  status: StageStatus;
  durationMs?: number;
  /** Pointer to the log (path or URL) when one exists. */
  log?: string;
}

export interface CheckRow {
  id: string;
  status: 'passed' | 'failed' | 'failed-optional';
  durationMs?: number;
  failedPackages: number;
}

export interface CheckFailure {
  checkId: string;
  /** Package path as reported by the check (absent for repo-level checks). */
  packagePath?: string;
  /** Package name when known, else the directory name. */
  package: string;
  optional: boolean;
  classification: FailureClassification;
  /** Stable classification rule id. */
  rule: string;
  /** One-line root cause. */
  rootCause: string;
  hint: string;
  timedOut: boolean;
  exitCode?: number;
  /** Redacted tail of the captured output (partial output for timeouts). */
  outputExcerpt?: string;
  /** Envelope-compatible error (see error-codes.ts). */
  error: ReleaseErrorEnvelope;
  /** Command to re-run after fixing. */
  resumeCommand: string;
}

export interface PackageFailureGroup {
  package: string;
  packagePath?: string;
  failures: CheckFailure[];
}

export interface ReleaseRunReport {
  schemaVersion: '1.0';
  generatedAt: string;
  flow?: string;
  scope?: string;
  ok: boolean;
  stages: StageRow[];
  checks: CheckRow[];
  summary: {
    /** Failures that fail the run (non-optional). */
    blockingFailures: number;
    optionalFailures: number;
    byClassification: Partial<Record<FailureClassification, number>>;
  };
  /** Every failing (check, package) pair, not just the first. */
  failures: CheckFailure[];
  byPackage: PackageFailureGroup[];
}

export interface BuildRunReportInput {
  results: CheckResult[];
  /** Known packages, used to turn paths into names. */
  packages?: Array<{ name: string; path: string }>;
  flow?: string;
  scope?: string;
  /** Wall-clock duration of the checks stage, if measured. */
  checksDurationMs?: number;
  /** Pointer to the checks log, if any. */
  checksLog?: string;
  /** Preflight outcome; adds a `preflight` stage row and its failures (classified `environment`). */
  preflight?: PreflightResult;
  now?: Date;
}

/**
 * Command to re-run after a fix. `kb release resume` does not exist yet
 * (roadmap R2.2); until then re-running the same checks command is the honest
 * next step. Keep this in one place so R2.2 can swap it.
 */
export function resumeCommandFor(flow?: string, scope?: string): string {
  const parts = ['pnpm', 'kb', 'release', 'checks'];
  if (flow) { parts.push('--flow', flow); }
  if (scope) { parts.push('--scope', scope); }
  return parts.join(' ');
}

const TAIL_LINES = 12;
const MAX_EXCERPT_CHARS = 1200;

/** Strip secrets and home paths from captured output. */
export function redact(text: string): string {
  return text
    .replace(/(_authToken\s*=\s*)\S+/gi, '$1[redacted]')
    .replace(/\b(npm_[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g, '[redacted]')
    .replace(/\b(token|password|secret)(\s*[=:]\s*)\S+/gi, '$1$2[redacted]')
    .replace(/\/(?:Users|home)\/[^/\s]+/g, '~');
}

function excerptOf(details: CheckResultDetails): string | undefined {
  const source = details.stderr?.trim() ? details.stderr : details.stdout;
  if (!source || !source.trim()) { return undefined; }
  const tail = source.trim().split('\n').slice(-TAIL_LINES).join('\n');
  const redacted = redact(tail);
  return redacted.length > MAX_EXCERPT_CHARS ? `…${redacted.slice(-MAX_EXCERPT_CHARS)}` : redacted;
}

export function buildReleaseRunReport(input: BuildRunReportInput): ReleaseRunReport {
  const names = new Map((input.packages ?? []).map(p => [p.path, p.name]));
  const resumeCommand = resumeCommandFor(input.flow, input.scope);
  const failures: CheckFailure[] = [];
  const checks: CheckRow[] = [];

  // Preflight failures are environment problems by construction.
  for (const p of input.preflight?.checks ?? []) {
    if (p.status !== 'failed' || !p.error) { continue; }
    failures.push({
      checkId: `preflight:${p.id}`,
      package: '(environment)',
      optional: false,
      classification: 'environment',
      rule: `preflight-${p.id}`,
      rootCause: p.error.cause ?? p.message,
      hint: p.error.hint ?? '',
      timedOut: false,
      error: p.error,
      resumeCommand: preflightCommand(input.flow),
    });
  }

  for (const result of input.results) {
    const failing: Array<{ path?: string; details: CheckResultDetails }> = [];
    if (!result.ok) {
      if (result.packages && result.packages.length > 0) {
        for (const p of result.packages) {
          if (!p.ok) { failing.push({ path: p.path, details: p.details ?? {} }); }
        }
      }
      // Single-path checks (or results without a per-package breakdown).
      if (failing.length === 0) {
        failing.push({ path: result.details?.packagePath, details: result.details ?? {} });
      }
    }

    for (const f of failing) {
      const verdict = classifyFailure({
        error: f.details.error,
        stdout: f.details.stdout,
        stderr: f.details.stderr,
        exitCode: f.details.exitCode,
      });
      const optional = Boolean(result.optional);
      const packagePath = f.path ?? f.details.packagePath;
      const pkg = packagePath ? (names.get(packagePath) ?? basename(packagePath)) : '(repository)';
      const error = createReleaseError({
        code: verdict.code,
        cause: verdict.rootCause,
        hint: verdict.hint,
        severity: optional ? 'warning' : 'error',
        actions: [{ id: 'rerun-checks', label: 'Re-run checks', command: resumeCommand }],
        details: {
          check: result.id,
          package: pkg,
          classification: verdict.classification,
          rule: verdict.rule,
        },
      });
      failures.push({
        checkId: result.id,
        packagePath,
        package: pkg,
        optional,
        classification: verdict.classification,
        rule: verdict.rule,
        rootCause: verdict.rootCause,
        hint: verdict.hint,
        timedOut: verdict.timedOut,
        exitCode: f.details.exitCode,
        outputExcerpt: excerptOf(f.details),
        error,
        resumeCommand,
      });
    }

    checks.push({
      id: result.id,
      status: result.ok ? 'passed' : result.optional ? 'failed-optional' : 'failed',
      durationMs: result.timingMs,
      failedPackages: failing.length,
    });
  }

  const blocking = failures.filter(f => !f.optional);
  const byClassification: Partial<Record<FailureClassification, number>> = {};
  for (const f of failures) {
    byClassification[f.classification] = (byClassification[f.classification] ?? 0) + 1;
  }

  const groups = new Map<string, PackageFailureGroup>();
  for (const f of failures) {
    const key = f.packagePath ?? f.package;
    const group = groups.get(key) ?? { package: f.package, packagePath: f.packagePath, failures: [] };
    group.failures.push(f);
    groups.set(key, group);
  }

  const ok = blocking.length === 0;
  const checksDuration = input.checksDurationMs ?? sumDurations(input.results);

  return {
    schemaVersion: '1.0',
    generatedAt: (input.now ?? new Date()).toISOString(),
    flow: input.flow,
    scope: input.scope,
    ok,
    stages: [
      ...(input.preflight
        ? [{
            stage: 'preflight',
            status: (input.preflight.ok ? 'passed' : 'failed') as StageStatus,
            durationMs: input.preflight.durationMs,
          }]
        : []),
      ...(input.results.length === 0 && input.preflight
        ? [{ stage: 'checks', status: 'not-run' as StageStatus }]
        : [{
            stage: 'checks',
            status: (blocking.some(f => !f.checkId.startsWith('preflight:')) ? 'failed' : 'passed') as StageStatus,
            durationMs: checksDuration,
            log: input.checksLog,
          }]),
    ],
    checks,
    summary: {
      blockingFailures: blocking.length,
      optionalFailures: failures.length - blocking.length,
      byClassification,
    },
    failures,
    byPackage: [...groups.values()],
  };
}

function sumDurations(results: CheckResult[]): number | undefined {
  const timed = results.filter(r => typeof r.timingMs === 'number');
  return timed.length === 0 ? undefined : timed.reduce((s, r) => s + (r.timingMs ?? 0), 0);
}
