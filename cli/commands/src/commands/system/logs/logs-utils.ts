/**
 * @module logs-utils
 * Shared utilities for log CLI commands.
 * Parsing, formatting, correlation, diagnostics.
 */

import type { LogRecord, ILogReader } from "@kb-labs/core-platform";
import { throwSystemCataloguedFailure } from '@kb-labs/shared-command-kit';

// ─── Relative Time Parsing ──────────────────────────────────────────────────

const TIME_UNITS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  min: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * Parse relative time string to absolute timestamp.
 * Supports: "30s", "5m", "2h", "1d", "1w", ISO dates, epoch ms.
 *
 * @returns timestamp in milliseconds
 */
export function parseRelativeTime(input: string): number {
  // Try relative format: "1h", "30m", "2d"
  const match = input.match(/^(\d+)(s|m|min|h|d|w)$/);
  if (match) {
    const value = parseInt(match[1]!, 10);
    const unit = match[2]!;
    const ms = TIME_UNITS[unit];
    if (ms) {
      return Date.now() - value * ms;
    }
  }

  // Try epoch milliseconds
  const asNumber = Number(input);
  if (!isNaN(asNumber) && asNumber > 1_000_000_000_000) {
    return asNumber;
  }

  // Try ISO date string
  const date = new Date(input);
  if (!isNaN(date.getTime())) {
    return date.getTime();
  }

  throwSystemCataloguedFailure({ code: 'KB_RUNTIME_INPUT_INVALID', message: `Invalid time format: "${input}". Use relative (1h, 30m, 2d) or ISO date.`, hint: 'Use `--since 1h`, `--since 30m`, `--since 2d`, or an ISO date, then retry the logs command.' });
}

// ─── Log Formatting ─────────────────────────────────────────────────────────

/** Map Pino numeric level to string (matches REST API) */
function mapPinoLevel(level: unknown): string {
  if (typeof level === "string") {
    return level;
  }
  if (typeof level !== "number") {
    return "info";
  }
  if (level <= 10) {
    return "trace";
  }
  if (level <= 20) {
    return "debug";
  }
  if (level <= 30) {
    return "info";
  }
  if (level <= 40) {
    return "warn";
  }
  if (level <= 50) {
    return "error";
  }
  return "fatal";
}

const LEVEL_COLORS: Record<string, string> = {
  trace: "\x1b[90m", // gray
  debug: "\x1b[36m", // cyan
  info: "\x1b[32m", // green
  warn: "\x1b[33m", // yellow
  error: "\x1b[31m", // red
  fatal: "\x1b[35m", // magenta
};
const RESET = "\x1b[0m";

/**
 * Format a LogRecord for human-readable CLI output.
 * [10:23:45] ERROR [rest] Connection refused to localhost:6333
 */
export function formatLogLine(record: LogRecord): string {
  const pinoLevel = record.fields.level;
  const level =
    typeof pinoLevel === "number" ? mapPinoLevel(pinoLevel) : record.level;
  const time = new Date(record.timestamp).toISOString().slice(11, 19); // HH:mm:ss
  const levelPad = level.toUpperCase().padEnd(5);
  const color = LEVEL_COLORS[level] ?? "";
  const source = record.source ? ` [${record.source}]` : "";
  const msg =
    typeof record.message === "string"
      ? record.message
      : JSON.stringify(record.message);

  return `${color}[${time}] ${levelPad}${RESET}${source} ${msg}`;
}

/**
 * Format a LogRecord for JSON output (clean ISO dates, flat structure).
 */
export function formatLogJson(record: LogRecord): object {
  const pinoLevel = record.fields.level;
  const level =
    typeof pinoLevel === "number" ? mapPinoLevel(pinoLevel) : record.level;
  const msg =
    typeof record.message === "string"
      ? record.message
      : JSON.stringify(record.message);
  const { level: _level, time: _time, ...restFields } = record.fields;

  return {
    id: record.id,
    time: new Date(record.timestamp).toISOString(),
    level,
    msg,
    source: record.source,
    ...restFields,
  };
}

// ─── Correlation ────────────────────────────────────────────────────────────

export interface CorrelationKeys {
  requestId?: string;
  traceId?: string;
  executionId?: string;
  sessionId?: string;
}

/** Extract correlation keys from LogRecord.fields (matches REST API pattern) */
export function extractCorrelationKeys(record: LogRecord): CorrelationKeys {
  return {
    requestId: record.fields.requestId as string | undefined,
    traceId: record.fields.traceId as string | undefined,
    executionId: record.fields.executionId as string | undefined,
    sessionId: record.fields.sessionId as string | undefined,
  };
}

/**
 * Find logs related to the target log by correlation keys.
 * Strategy (from REST API):
 * 1. Query ±windowMs around target timestamp
 * 2. Match by any shared correlation key
 * 3. Fallback: same source in time window
 */
export async function findRelatedLogs(
  reader: ILogReader,
  target: LogRecord,
  windowMs: number = 60_000,
): Promise<LogRecord[]> {
  const keys = extractCorrelationKeys(target);

  // Strategy 1: correlation keys
  if (keys.requestId || keys.traceId || keys.executionId) {
    const result = await reader.query(
      { from: target.timestamp - windowMs, to: target.timestamp + windowMs },
      { limit: 1000 },
    );

    const related = result.logs.filter((log) => {
      if (log.id === target.id) {
        return false;
      }
      const logKeys = extractCorrelationKeys(log);
      return (
        (keys.requestId && logKeys.requestId === keys.requestId) ||
        (keys.traceId && logKeys.traceId === keys.traceId) ||
        (keys.executionId && logKeys.executionId === keys.executionId) ||
        (keys.sessionId && logKeys.sessionId === keys.sessionId)
      );
    });

    if (related.length > 0) {
      return related.sort((a, b) => a.timestamp - b.timestamp);
    }
  }

  // Strategy 2: fallback to same source + time window
  const result = await reader.query(
    {
      source: target.source,
      from: target.timestamp - windowMs,
      to: target.timestamp + windowMs,
    },
    { limit: 50 },
  );

  return result.logs
    .filter((log) => log.id !== target.id)
    .sort((a, b) => a.timestamp - b.timestamp);
}

// ─── Diagnostics ────────────────────────────────────────────────────────────

export interface TopError {
  message: string;
  count: number;
  source: string;
  firstSeen: string;
  lastSeen: string;
}

export interface SourceBreakdown {
  errors: number;
  warnings: number;
}

export interface LogDiagnostics {
  total: number;
  errors: number;
  warnings: number;
  sources: string[];
  topErrors: TopError[];
  bySource: Record<string, SourceBreakdown>;
  recentErrors: object[];
}

/**
 * Compute diagnostic statistics from a set of logs.
 * Used by `logs diagnose` for the structured report.
 */
// eslint-disable-next-line sonarjs/cognitive-complexity
export function computeLogStats(logs: LogRecord[]): LogDiagnostics {
  const bySource: Record<string, SourceBreakdown> = {};
  const errorMessages = new Map<
    string,
    { count: number; source: string; firstSeen: number; lastSeen: number }
  >();
  let errors = 0;
  let warnings = 0;

  for (const log of logs) {
    const level =
      typeof log.fields.level === "number"
        ? mapPinoLevel(log.fields.level)
        : log.level;
    const source = log.source || "unknown";

    if (!bySource[source]) {
      bySource[source] = { errors: 0, warnings: 0 };
    }

    if (level === "error" || level === "fatal") {
      errors++;
      bySource[source]!.errors++;

      const msg =
        typeof log.message === "string"
          ? log.message
          : JSON.stringify(log.message);
      const existing = errorMessages.get(msg);
      if (existing) {
        existing.count++;
        if (log.timestamp < existing.firstSeen) {
          existing.firstSeen = log.timestamp;
        }
        if (log.timestamp > existing.lastSeen) {
          existing.lastSeen = log.timestamp;
        }
      } else {
        errorMessages.set(msg, {
          count: 1,
          source,
          firstSeen: log.timestamp,
          lastSeen: log.timestamp,
        });
      }
    } else if (level === "warn") {
      warnings++;
      bySource[source]!.warnings++;
    }
  }

  const topErrors: TopError[] = Array.from(errorMessages.entries())
    .map(([message, data]) => ({
      message,
      count: data.count,
      source: data.source,
      firstSeen: new Date(data.firstSeen).toISOString(),
      lastSeen: new Date(data.lastSeen).toISOString(),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // Get last 10 error logs
  const recentErrors = logs
    .filter((l) => {
      const level =
        typeof l.fields.level === "number"
          ? mapPinoLevel(l.fields.level)
          : l.level;
      return level === "error" || level === "fatal";
    })
    .slice(-10)
    .map(formatLogJson);

  return {
    total: logs.length,
    errors,
    warnings,
    sources: Object.keys(bySource),
    topErrors,
    bySource,
    recentErrors,
  };
}
