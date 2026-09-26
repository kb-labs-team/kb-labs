/**
 * agent:quality:report - Agent execution quality control report
 *
 * Usage:
 *   pnpm kb agent quality report
 *   pnpm kb agent quality report --days=3
 *   pnpm kb agent quality report --session-id=session-123
 *   pnpm kb agent quality report --json
 */

import { defineCommand, type PluginContextV3 } from '@kb-labs/sdk';
import { resolveRuntimeStatePath } from '@kb-labs/core-project-registry';
import type { CommandResult } from '@kb-labs/sdk';
import { promises as fs } from 'fs';
import path from 'path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

type QualityReportInput = {
  days?: number;
  limit?: number;
  sessionId?: string;
  'session-id'?: string;
  json?: boolean;
};

type KpiRunEvent = {
  type: string;
  ts?: string;
  payload?: {
    sessionId?: string;
    success?: boolean;
    task?: string;
    summaryPreview?: string;
    tokensUsed?: number;
    durationMs?: number;
    iterationsUsed?: number;
    iterationBudget?: number;
    iterationUtilization?: number;
    toolCallsTotal?: number;
    toolErrorRate?: number;
    todoUsed?: boolean;
    evidenceDensity?: number;
    driftRate?: number;
    startTier?: 'small' | 'medium' | 'large';
    finalTier?: 'small' | 'medium' | 'large';
    escalated?: boolean;
    escalationCount?: number;
    escalationReasons?: string[];
    escalationPath?: string[];
    qualityGate?: {
      status?: 'pass' | 'partial';
      score?: number;
      reasons?: string[];
    };
    qualityGateStatus?: 'pass' | 'partial';
  };
};

type RegressionEvent = {
  type: string;
  ts?: string;
  payload?: {
    sessionId?: string;
    reasons?: string[];
    metrics?: {
      driftRate?: number;
      evidenceDensity?: number;
      toolErrorRate?: number;
      iterationsUsed?: number;
      iterationBudget?: number;
    };
  };
};

type RunSnapshot = {
  ts: string;
  sessionId: string;
  success: boolean;
  task: string;
  summaryPreview: string;
  tokensUsed: number;
  durationMs: number;
  iterationsUsed: number;
  iterationBudget: number;
  iterationUtilization: number;
  toolCallsTotal: number;
  toolErrorRate: number;
  todoUsed: boolean;
  evidenceDensity: number;
  driftRate: number;
  qualityStatus: 'pass' | 'partial';
  qualityScore: number;
  qualityReasons: string[];
  startTier: 'small' | 'medium' | 'large';
  finalTier: 'small' | 'medium' | 'large';
  escalated: boolean;
  escalationCount: number;
  escalationReasons: string[];
  escalationPath: string[];
};

function deriveQualityStatus(payload: KpiRunEvent['payload'] | undefined): 'pass' | 'partial' {
  if (payload?.qualityGate?.status === 'pass' || payload?.qualityGate?.status === 'partial') {
    return payload.qualityGate.status;
  }
  if (payload?.qualityGateStatus === 'pass' || payload?.qualityGateStatus === 'partial') {
    return payload.qualityGateStatus;
  }
  return payload?.success ? 'pass' : 'partial';
}

export default defineCommand({
  id: 'quality:report',
  description: 'Show quality control report for agent runs (quality, tokens, tools, drift, regressions)',

  handler: {
    async execute(ctx: PluginContextV3, input: QualityReportInput): Promise<CommandResult<unknown>> {
      const flags = ('flags' in input && typeof (input as { flags?: unknown }).flags === 'object' && (input as { flags?: unknown }).flags !== null)
        ? (input as { flags: QualityReportInput }).flags
        : input;
      const days = Number(flags.days ?? 1);
      const limit = Number(flags.limit ?? 200);
      const rawSessionId = flags['session-id'] ?? flags.sessionId;
      const sessionIdFilter = typeof rawSessionId === 'string' ? rawSessionId : undefined;
      const json = Boolean(flags.json);

      if (!Number.isFinite(days) || days <= 0) {
        const err = { success: false, error: '--days must be a positive number' };
        ctx.ui?.json?.(err);
        return { ok: false, error: 'Command failed', result: err };
      }

      const analyticsDir = resolveRuntimeStatePath(process.cwd(), ['analytics', 'buffer']);
      const files = await listEventFiles(analyticsDir, days);
      if (files.length === 0) {
        const out = { success: true, message: 'No analytics files found for selected period', runs: 0 };
        ctx.ui?.json?.(out);
        return { ok: true, result: out };
      }

      const since = Date.now() - days * 24 * 60 * 60 * 1000;
      let { runs, regressions } = await readEvents(files, since, sessionIdFilter, limit);
      if (runs.length === 0) {
        const sqlitePath = resolveRuntimeStatePath(process.cwd(), ['analytics', 'analytics.sqlite']);
        const sqliteEvents = await readEventsFromSqlite(sqlitePath, since, sessionIdFilter, limit);
        runs = sqliteEvents.runs;
        regressions = sqliteEvents.regressions;
      }
      const report = buildReport(runs, regressions, { days, sessionIdFilter });

      if (json) {
        ctx.ui?.json?.({ success: true, report });
      } else {
        printReport(ctx, report);
      }

      return { ok: true, result: report };
    },
  },
});

async function listEventFiles(dir: string, days: number): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir);
    const candidates = entries
      .filter((name) => /^events-\d{8}\.jsonl$/.test(name))
      .sort();

    const keep = Math.max(1, Math.min(candidates.length, days + 2));
    return candidates.slice(-keep).map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

async function readEvents(
  files: string[],
  sinceMs: number,
  sessionIdFilter: string | undefined,
  limit: number
): Promise<{ runs: RunSnapshot[]; regressions: RegressionEvent[] }> {
  const runs: RunSnapshot[] = [];
  const regressions: RegressionEvent[] = [];

  for (const file of files) {
    const content = await fs.readFile(file, 'utf-8');
    const lines = content.split('\n').filter(Boolean);

    for (const line of lines) {
      let rawParsed: unknown;
      try {
        rawParsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!rawParsed || typeof rawParsed !== 'object') {
        continue;
      }
      const raw = rawParsed as Record<string, unknown>;

      const ts = typeof raw['ts'] === 'string' ? Date.parse(raw['ts']) : NaN;
      if (!Number.isFinite(ts) || ts < sinceMs) {
        continue;
      }

      if (raw['type'] === 'agent.kpi.run_completed') {
        const event = raw as unknown as KpiRunEvent;
        const p = event.payload || {};
        const sessionId = p.sessionId || 'unknown';
        if (sessionIdFilter && sessionId !== sessionIdFilter) {
          continue;
        }

        runs.push({
          ts: event.ts || new Date(ts).toISOString(),
          sessionId,
          success: Boolean(p.success),
          task: p.task || '',
          summaryPreview: p.summaryPreview || '',
          tokensUsed: Number(p.tokensUsed || 0),
          durationMs: Number(p.durationMs || 0),
          iterationsUsed: Number(p.iterationsUsed || 0),
          iterationBudget: Number(p.iterationBudget || 0),
          iterationUtilization: Number(p.iterationUtilization || 0),
          toolCallsTotal: Number(p.toolCallsTotal || 0),
          toolErrorRate: Number(p.toolErrorRate || 0),
          todoUsed: Boolean(p.todoUsed),
          evidenceDensity: Number(p.evidenceDensity || 0),
          driftRate: Number(p.driftRate || 0),
          qualityStatus: deriveQualityStatus(p),
          qualityScore: Number(p.qualityGate?.score ?? (p.success ? 1 : 0)),
          qualityReasons: Array.isArray(p.qualityGate?.reasons) ? p.qualityGate!.reasons! : [],
          startTier: (p.startTier === 'small' || p.startTier === 'large') ? p.startTier : 'medium',
          finalTier: (p.finalTier === 'small' || p.finalTier === 'large') ? p.finalTier : 'medium',
          escalated: Boolean(p.escalated),
          escalationCount: Number(p.escalationCount || 0),
          escalationReasons: Array.isArray(p.escalationReasons)
            ? p.escalationReasons.filter((v): v is string => typeof v === 'string')
            : [],
          escalationPath: Array.isArray(p.escalationPath)
            ? p.escalationPath.filter((v): v is string => typeof v === 'string')
            : [],
        });
      } else if (raw['type'] === 'agent.kpi.quality_regression') {
        const event = raw as unknown as RegressionEvent;
        const sessionId = event.payload?.sessionId;
        if (sessionIdFilter && sessionId !== sessionIdFilter) {
          continue;
        }
        regressions.push(event);
      }
    }
  }

  runs.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  const trimmedRuns = runs.slice(0, Math.max(1, limit));
  return { runs: trimmedRuns, regressions };
}

async function readEventsFromSqlite(
  sqlitePath: string,
  sinceMs: number,
  sessionIdFilter: string | undefined,
  limit: number,
): Promise<{ runs: RunSnapshot[]; regressions: RegressionEvent[] }> {
  try {
    await fs.access(sqlitePath);
  } catch {
    return { runs: [], regressions: [] };
  }

  const sinceIso = new Date(sinceMs).toISOString();
  const sql = [
    'SELECT type, ts, payload',
    'FROM events',
    `WHERE ts >= '${sinceIso}'`,
    "  AND type IN ('agent.kpi.run_completed', 'agent.kpi.quality_regression')",
    'ORDER BY ts DESC',
    `LIMIT ${Math.max(limit * 5, 500)};`,
  ].join(' ');

  try {
    const { stdout } = await execFile('sqlite3', ['-json', sqlitePath, sql], {
      maxBuffer: 20 * 1024 * 1024,
    });
    const rows = JSON.parse(stdout || '[]') as Array<{
      type?: string;
      ts?: string;
      payload?: string;
    }>;
    const pseudoFileEvents = rows.map((row) => ({
      type: row.type ?? '',
      ts: row.ts,
      payload: parseJsonSafe(row.payload),
    }));
    return readInMemoryEvents(pseudoFileEvents, sinceMs, sessionIdFilter, limit);
  } catch {
    return { runs: [], regressions: [] };
  }
}

function parseJsonSafe(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object') {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function readInMemoryEvents(
  rows: Array<{ type: string; ts?: string; payload?: Record<string, unknown> }>,
  sinceMs: number,
  sessionIdFilter: string | undefined,
  limit: number
): { runs: RunSnapshot[]; regressions: RegressionEvent[] } {
  const runs: RunSnapshot[] = [];
  const regressions: RegressionEvent[] = [];

  for (const raw of rows) {
    const ts = typeof raw.ts === 'string' ? Date.parse(raw.ts) : NaN;
    if (!Number.isFinite(ts) || ts < sinceMs) {
      continue;
    }

    if (raw.type === 'agent.kpi.run_completed') {
      const p = (raw.payload || {}) as KpiRunEvent['payload'];
      const sessionId = p?.sessionId || 'unknown';
      if (sessionIdFilter && sessionId !== sessionIdFilter) {
        continue;
      }
      runs.push({
        ts: raw.ts || new Date(ts).toISOString(),
        sessionId,
        success: Boolean(p?.success),
        task: p?.task || '',
        summaryPreview: p?.summaryPreview || '',
        tokensUsed: Number(p?.tokensUsed || 0),
        durationMs: Number(p?.durationMs || 0),
        iterationsUsed: Number(p?.iterationsUsed || 0),
        iterationBudget: Number(p?.iterationBudget || 0),
        iterationUtilization: Number(p?.iterationUtilization || 0),
        toolCallsTotal: Number(p?.toolCallsTotal || 0),
        toolErrorRate: Number(p?.toolErrorRate || 0),
        todoUsed: Boolean(p?.todoUsed),
        evidenceDensity: Number(p?.evidenceDensity || 0),
        driftRate: Number(p?.driftRate || 0),
        qualityStatus: deriveQualityStatus(p),
        qualityScore: Number(p?.qualityGate?.score ?? (p?.success ? 1 : 0)),
        qualityReasons: Array.isArray(p?.qualityGate?.reasons) ? p?.qualityGate.reasons : [],
        startTier: (p?.startTier === 'small' || p?.startTier === 'large') ? p.startTier : 'medium',
        finalTier: (p?.finalTier === 'small' || p?.finalTier === 'large') ? p.finalTier : 'medium',
        escalated: Boolean(p?.escalated),
        escalationCount: Number(p?.escalationCount || 0),
        escalationReasons: Array.isArray(p?.escalationReasons)
          ? p.escalationReasons.filter((v): v is string => typeof v === 'string')
          : [],
        escalationPath: Array.isArray(p?.escalationPath)
          ? p.escalationPath.filter((v): v is string => typeof v === 'string')
          : [],
      });
      continue;
    }

    if (raw.type === 'agent.kpi.quality_regression') {
      const event: RegressionEvent = {
        type: raw.type,
        ts: raw.ts,
        payload: raw.payload as RegressionEvent['payload'],
      };
      const sessionId = event.payload?.sessionId;
      if (sessionIdFilter && sessionId !== sessionIdFilter) {
        continue;
      }
      regressions.push(event);
    }
  }

  runs.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  return { runs: runs.slice(0, Math.max(1, limit)), regressions };
}

function buildReport(
  runs: RunSnapshot[],
  regressions: RegressionEvent[],
  meta: { days: number; sessionIdFilter?: string }
) {
  const count = runs.length;
  if (count === 0) {
    return {
      periodDays: meta.days,
      sessionId: meta.sessionIdFilter,
      runs: 0,
      message: 'No agent.kpi.run_completed events in selected period',
    };
  }

  const scorecard = scorecardOf(runs);

  const topTokenRuns = [...runs].sort((a, b) => b.tokensUsed - a.tokensUsed).slice(0, 5);
  const worstQualityRuns = [...runs]
    .sort((a, b) => a.qualityScore - b.qualityScore || b.tokensUsed - a.tokensUsed)
    .slice(0, 5);

  const alerts: string[] = [];
  if (scorecard.successRate < 0.85) {alerts.push(`Low success rate: ${(scorecard.successRate * 100).toFixed(1)}%`);}
  if (scorecard.qualityPassRate < 0.9) {alerts.push(`Quality pass rate below target: ${(scorecard.qualityPassRate * 100).toFixed(1)}%`);}
  if (scorecard.avgToolErrorRate > 0.05) {alerts.push(`High tool error rate: ${(scorecard.avgToolErrorRate * 100).toFixed(1)}%`);}
  if (scorecard.avgDriftRate > 0.08) {alerts.push(`Scope drift is elevated: ${(scorecard.avgDriftRate * 100).toFixed(1)}%`);}
  if (scorecard.nearBudgetRate > 0.35) {alerts.push(`Too many runs near iteration budget: ${(scorecard.nearBudgetRate * 100).toFixed(1)}%`);}
  if (scorecard.escalationRate > 0.55) {alerts.push(`Escalation rate too high: ${(scorecard.escalationRate * 100).toFixed(1)}%`);}
  if (scorecard.escalationRate > 0.2 && scorecard.escalationSuccessRate < 0.7) {
    alerts.push(`Escalation effectiveness is low: ${(scorecard.escalationSuccessRate * 100).toFixed(1)}%`);
  }
  if (regressions.length > 0) {alerts.push(`Quality regression events observed: ${regressions.length}`);}

  const sliceSize = Math.max(3, Math.min(10, Math.floor(runs.length / 2)));
  const latestSlice = runs.slice(0, sliceSize);
  const previousSlice = runs.slice(sliceSize, sliceSize * 2);
  const latestScorecard = scorecardOf(latestSlice);
  const previousScorecard = scorecardOf(previousSlice);

  const slices = previousSlice.length > 0
    ? {
      sliceSize,
      latest: latestScorecard,
      previous: previousScorecard,
      delta: {
        successRate: latestScorecard.successRate - previousScorecard.successRate,
        qualityPassRate: latestScorecard.qualityPassRate - previousScorecard.qualityPassRate,
        avgQualityScore: latestScorecard.avgQualityScore - previousScorecard.avgQualityScore,
        avgTokens: latestScorecard.avgTokens - previousScorecard.avgTokens,
        p95Tokens: latestScorecard.p95Tokens - previousScorecard.p95Tokens,
        avgDurationMs: latestScorecard.avgDurationMs - previousScorecard.avgDurationMs,
        avgToolCalls: latestScorecard.avgToolCalls - previousScorecard.avgToolCalls,
        avgToolErrorRate: latestScorecard.avgToolErrorRate - previousScorecard.avgToolErrorRate,
        avgDriftRate: latestScorecard.avgDriftRate - previousScorecard.avgDriftRate,
        avgEvidenceDensity: latestScorecard.avgEvidenceDensity - previousScorecard.avgEvidenceDensity,
        nearBudgetRate: latestScorecard.nearBudgetRate - previousScorecard.nearBudgetRate,
        escalationRate: latestScorecard.escalationRate - previousScorecard.escalationRate,
        escalationSuccessRate: latestScorecard.escalationSuccessRate - previousScorecard.escalationSuccessRate,
        avgEscalationCount: latestScorecard.avgEscalationCount - previousScorecard.avgEscalationCount,
      },
    }
    : null;

  return {
    periodDays: meta.days,
    sessionId: meta.sessionIdFilter,
    runs: count,
    regressions: regressions.length,
    scorecard,
    slices,
    alerts,
    topTokenRuns: topTokenRuns.map(toRunBrief),
    worstQualityRuns: worstQualityRuns.map(toRunBrief),
  };
}

function toRunBrief(run: RunSnapshot) {
  return {
    ts: run.ts,
    sessionId: run.sessionId,
    task: run.task.slice(0, 120),
    tokensUsed: run.tokensUsed,
    durationMs: run.durationMs,
    toolCallsTotal: run.toolCallsTotal,
    qualityStatus: run.qualityStatus,
    qualityScore: run.qualityScore,
    qualityReasons: run.qualityReasons,
    startTier: run.startTier,
    finalTier: run.finalTier,
    escalated: run.escalated,
    escalationCount: run.escalationCount,
    escalationReasons: run.escalationReasons,
  };
}

function avg(values: number[]): number {
  if (values.length === 0) {return 0;}
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function p95(values: number[]): number {
  if (values.length === 0) {return 0;}
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1));
  return sorted[index] || 0;
}

function scorecardOf(runs: RunSnapshot[]) {
  const escalatedRuns = runs.filter((r) => r.escalated);
  const nonEscalatedRuns = runs.filter((r) => !r.escalated);

  return {
    successRate: avg(runs.map((r) => (r.success ? 1 : 0))),
    qualityPassRate: avg(runs.map((r) => (r.qualityStatus === 'pass' ? 1 : 0))),
    avgQualityScore: avg(runs.map((r) => r.qualityScore)),
    avgTokens: avg(runs.map((r) => r.tokensUsed)),
    p95Tokens: p95(runs.map((r) => r.tokensUsed)),
    avgDurationMs: avg(runs.map((r) => r.durationMs)),
    avgToolCalls: avg(runs.map((r) => r.toolCallsTotal)),
    avgToolErrorRate: avg(runs.map((r) => r.toolErrorRate)),
    avgDriftRate: avg(runs.map((r) => r.driftRate)),
    avgEvidenceDensity: avg(runs.map((r) => r.evidenceDensity)),
    nearBudgetRate: avg(runs.map((r) => (r.iterationUtilization >= 0.9 ? 1 : 0))),
    escalationRate: avg(runs.map((r) => (r.escalated ? 1 : 0))),
    escalationSuccessRate: escalatedRuns.length > 0 ? avg(escalatedRuns.map((r) => (r.success ? 1 : 0))) : 0,
    avgEscalationCount: avg(runs.map((r) => r.escalationCount)),
    avgTokensEscalated: escalatedRuns.length > 0 ? avg(escalatedRuns.map((r) => r.tokensUsed)) : 0,
    avgTokensNonEscalated: nonEscalatedRuns.length > 0 ? avg(nonEscalatedRuns.map((r) => r.tokensUsed)) : 0,
    avgQualityEscalated: escalatedRuns.length > 0 ? avg(escalatedRuns.map((r) => r.qualityScore)) : 0,
    avgQualityNonEscalated: nonEscalatedRuns.length > 0 ? avg(nonEscalatedRuns.map((r) => r.qualityScore)) : 0,
  };
}

function printReport(ctx: PluginContextV3, report: ReturnType<typeof buildReport>): void {
  if (report.runs === 0) {
    ctx.ui.write(`No KPI runs for selected period (${report.periodDays}d)\n`);
    return;
  }

  if (!('scorecard' in report)) { return; }
  const s = report.scorecard;
  if (s === undefined) { return; }
  ctx.ui.write('┌── Agent Quality Control Report\n');
  ctx.ui.write(`│  Period: ${report.periodDays}d\n`);
  if (report.sessionId) {
    ctx.ui.write(`│  Session: ${report.sessionId}\n`);
  }
  ctx.ui.write(`│  Runs: ${report.runs} | Regressions: ${report.regressions}\n`);
  ctx.ui.write('│\n');
  ctx.ui.write(`│  Success Rate: ${(s.successRate * 100).toFixed(1)}%\n`);
  ctx.ui.write(`│  Quality Pass: ${(s.qualityPassRate * 100).toFixed(1)}% | Avg score: ${s.avgQualityScore.toFixed(2)}\n`);
  ctx.ui.write(`│  Tokens: avg ${Math.round(s.avgTokens)} | p95 ${Math.round(s.p95Tokens)}\n`);
  ctx.ui.write(`│  Duration: avg ${(s.avgDurationMs / 1000).toFixed(1)}s\n`);
  ctx.ui.write(`│  Tools: avg ${s.avgToolCalls.toFixed(1)} | error ${(s.avgToolErrorRate * 100).toFixed(2)}%\n`);
  ctx.ui.write(`│  Drift: ${(s.avgDriftRate * 100).toFixed(2)}% | Evidence density: ${s.avgEvidenceDensity.toFixed(2)}\n`);
  ctx.ui.write(`│  Near budget rate: ${(s.nearBudgetRate * 100).toFixed(1)}%\n`);
  ctx.ui.write(`│  Escalation: ${(s.escalationRate * 100).toFixed(1)}% runs | success ${(s.escalationSuccessRate * 100).toFixed(1)}% | avg count ${s.avgEscalationCount.toFixed(2)}\n`);
  if (s.escalationRate > 0 && s.escalationRate < 1) {
    const tokenDelta = s.avgTokensEscalated - s.avgTokensNonEscalated;
    const qualityDelta = s.avgQualityEscalated - s.avgQualityNonEscalated;
    ctx.ui.write(`│  Escalated vs non-escalated: Δtokens ${tokenDelta >= 0 ? '+' : ''}${Math.round(tokenDelta)} | Δquality ${qualityDelta >= 0 ? '+' : ''}${qualityDelta.toFixed(2)}\n`);
  } else {
    ctx.ui.write('│  Escalated vs non-escalated: n/a (need both escalated and non-escalated runs)\n');
  }

  if (report.slices) {
    const d = report.slices.delta;
    ctx.ui.write('│\n');
    ctx.ui.write(`│  Slices (${report.slices.sliceSize} latest vs previous):\n`);
    ctx.ui.write(`│  Δ Quality score: ${d.avgQualityScore >= 0 ? '+' : ''}${d.avgQualityScore.toFixed(2)}\n`);
    ctx.ui.write(`│  Δ Avg tokens: ${d.avgTokens >= 0 ? '+' : ''}${Math.round(d.avgTokens)}\n`);
    ctx.ui.write(`│  Δ Avg duration: ${d.avgDurationMs >= 0 ? '+' : ''}${(d.avgDurationMs / 1000).toFixed(1)}s\n`);
    ctx.ui.write(`│  Δ Tool errors: ${d.avgToolErrorRate >= 0 ? '+' : ''}${(d.avgToolErrorRate * 100).toFixed(2)}%\n`);
    ctx.ui.write(`│  Δ Drift: ${d.avgDriftRate >= 0 ? '+' : ''}${(d.avgDriftRate * 100).toFixed(2)}%\n`);
    ctx.ui.write(`│  Δ Escalation rate: ${d.escalationRate >= 0 ? '+' : ''}${(d.escalationRate * 100).toFixed(1)}%\n`);
    ctx.ui.write(`│  Δ Escalation success: ${d.escalationSuccessRate >= 0 ? '+' : ''}${(d.escalationSuccessRate * 100).toFixed(1)}%\n`);
    ctx.ui.write(`│  Δ Escalation count: ${d.avgEscalationCount >= 0 ? '+' : ''}${d.avgEscalationCount.toFixed(2)}\n`);
  }

  if (report.alerts.length > 0) {
    ctx.ui.write('│\n');
    ctx.ui.write('│  Alerts:\n');
    for (const alert of report.alerts) {
      ctx.ui.write(`│  - ${alert}\n`);
    }
  }

  ctx.ui.write('│\n');
  ctx.ui.write('│  Top expensive runs:\n');
  for (const run of report.topTokenRuns) {
    const esc = run.escalated ? ` | esc=${run.escalationCount}` : '';
    ctx.ui.write(`│  - ${run.ts} | tok=${run.tokensUsed} | q=${run.qualityScore.toFixed(2)}${esc} | ${run.task}\n`);
  }

  ctx.ui.write('│\n');
  ctx.ui.write('│  Worst quality runs:\n');
  for (const run of report.worstQualityRuns) {
    const reasons = (run.qualityReasons || []).join(', ');
    ctx.ui.write(`│  - ${run.ts} | q=${run.qualityScore.toFixed(2)} | tok=${run.tokensUsed} | reasons=${reasons || 'n/a'}\n`);
  }
  ctx.ui.write('└──\n');
}
