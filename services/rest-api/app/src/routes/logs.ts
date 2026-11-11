import { withUxErrorResponses } from './route-schema.js';
/**
 * @module @kb-labs/rest-api-app/routes/logs
 * Live log streaming and querying endpoints
 */

import type { FastifyInstance } from "fastify";
import { platform } from "@kb-labs/core-runtime";
import type { LogQuery, LogRecord, LogLevel } from "@kb-labs/core-platform";
import { createSseStream } from "@kb-labs/shared-http";

/** Frontend-shaped log record returned by toFrontendLogRecord */
interface FrontendLogRecord {
  id: string;
  time: string;
  level: string;
  msg: string;
  plugin?: string;
  [key: string]: unknown;
}

/** Statistics shape used in summarization */
interface LogStats {
  total: number;
  byLevel: Record<string, number>;
  byPlugin: Record<string, number>;
  topErrors: Array<{ message: string; count: number }>;
  timeRange: { from: string | null; to: string | null };
}

/** Error entry shape used in topErrors iteration */
interface TopError {
  message: string;
  count: number;
}

const logRecordSchema = { type: 'object', properties: { id: { type: 'string' }, time: { type: 'string', format: 'date-time' }, level: { type: 'string' }, msg: { type: 'string' }, plugin: { type: 'string' } }, required: ['id', 'time', 'level', 'msg'], additionalProperties: true } as const;
const logQuerySchema = { type: 'object', properties: { level: { enum: ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] }, plugin: { type: 'string' }, from: { type: 'string', format: 'date-time' }, to: { type: 'string', format: 'date-time' }, search: { type: 'string', minLength: 1 }, limit: { type: 'string', pattern: '^[1-9][0-9]*$' }, offset: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' } }, additionalProperties: false } as const;

/**
 * Map Pino numeric level to string level
 */
function mapPinoLevelToString(level: number | string): string {
  if (typeof level === "string") {
    return level;
  }

  // Pino levels: 10=trace, 20=debug, 30=info, 40=warn, 50=error, 60=fatal
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

/**
 * Convert internal LogRecord to frontend LogRecord format
 */
function toFrontendLogRecord(record: LogRecord): FrontendLogRecord {
  // Extract level from fields if it's a Pino log (numeric level)
  const pinoLevel = record.fields.level;
  const levelStr =
    typeof pinoLevel === "number"
      ? mapPinoLevelToString(pinoLevel)
      : record.level;

  // Ensure message is a string
  const messageStr =
    typeof record.message === "string"
      ? record.message
      : JSON.stringify(record.message);

  // Remove 'level' and 'time' from fields to avoid overwriting our converted values
  const { level: _level, time: _time, ...restFields } = record.fields;

  return {
    id: record.id, // Include ID for navigation to detail page
    time: new Date(record.timestamp).toISOString(),
    level: levelStr,
    msg: messageStr,
    ...restFields,
  };
}

/**
 * Build LLM prompt for log summarization
 */
function buildLogSummaryPrompt(
  question: string,
  logs: FrontendLogRecord[],
  stats: LogStats,
  includeContext: {
    errors?: boolean;
    warnings?: boolean;
    info?: boolean;
    metadata?: boolean;
    stackTraces?: boolean;
  },
): string {
  let prompt = `You are analyzing application logs. User question: "${question}"\n\n`;

  // Add statistics
  prompt += `Statistics:\n`;
  prompt += `Total logs: ${stats.total}\n`;
  prompt += `Errors: ${stats.byLevel.error || 0}\n`;
  prompt += `Warnings: ${stats.byLevel.warn || 0}\n`;
  prompt += `Info: ${stats.byLevel.info || 0}\n`;

  if (stats.timeRange.from && stats.timeRange.to) {
    prompt += `Time range: ${stats.timeRange.from} to ${stats.timeRange.to}\n`;
  }

  if (stats.topErrors.length > 0) {
    prompt += `\nTop Errors:\n`;
    stats.topErrors.slice(0, 5).forEach((err: TopError, idx: number) => {
      prompt += `${idx + 1}. "${err.message}" (${err.count} occurrences)\n`;
    });
  }

  // Filter logs based on includeContext
  const relevantLogs = logs.filter((log) => {
    if (!includeContext.errors && log.level === "error") {
      return false;
    }
    if (!includeContext.warnings && log.level === "warn") {
      return false;
    }
    if (!includeContext.info && log.level === "info") {
      return false;
    }
    return true;
  });

  // Add log entries (limit to 100 most recent)
  prompt += `\nLog Entries (${Math.min(relevantLogs.length, 100)} most recent):\n`;
  relevantLogs.slice(-100).forEach((log) => {
    prompt += `[${log.time}] ${log.level.toUpperCase()}`;

    if (includeContext.metadata && log.plugin) {
      prompt += ` [${log.plugin}]`;
    }

    prompt += `: ${log.msg || "(no message)"}\n`;

    if (includeContext.metadata && (log.traceId || log.executionId)) {
      if (log.traceId) {
        prompt += `  traceId: ${log.traceId}\n`;
      }
      if (log.executionId) {
        prompt += `  executionId: ${log.executionId}\n`;
      }
    }

    const logErr = log.err as { stack?: string } | undefined;
    if (includeContext.stackTraces && logErr?.stack) {
      prompt += `  stack: ${logErr.stack.split("\n").slice(0, 5).join("\n  ")}\n`;
    }
  });

  // Add instructions
  prompt += `\nInstructions:\n`;
  prompt += `Provide a clear, concise summary answering the user's question as plain text. Focus on:\n`;
  prompt += `1. What happened (timeline of events)\n`;
  prompt += `2. Root causes if errors are present\n`;
  prompt += `3. Patterns or trends you notice\n`;
  prompt += `4. Actionable recommendations if applicable\n`;
  prompt += `\nKeep the summary under 300 words. Use simple paragraphs separated by double newlines. Do not use markdown formatting (no **, ##, -, or other markdown syntax). Write in clear, professional language.\n`;

  return prompt;
}

/**
 * Extract correlation keys from log for finding related logs
 */
function extractCorrelationKeys(log: LogRecord): {
  requestId?: string;
  traceId?: string;
  executionId?: string;
  sessionId?: string;
} {
  return {
    requestId: log.fields.requestId as string | undefined,
    traceId: log.fields.traceId as string | undefined,
    executionId: log.fields.executionId as string | undefined,
    sessionId: log.fields.sessionId as string | undefined,
  };
}

/**
 * Find logs related to the given log
 * Strategy:
 * 1. Try requestId/traceId/executionId (most specific)
 * 2. Fallback to time window + same source
 */
async function findRelatedLogs(
  targetLog: LogRecord,
): Promise<FrontendLogRecord[]> {
  const correlationKeys = extractCorrelationKeys(targetLog);
  const timeWindow = 60000; // 1 minute before/after

  // Strategy 1: Find by correlation IDs (most precise)
  if (
    correlationKeys.requestId ||
    correlationKeys.traceId ||
    correlationKeys.executionId
  ) {
    const relatedLogs: LogRecord[] = [];

    // Query all logs in time window
    const result = await platform.logs.query(
      {
        from: targetLog.timestamp - timeWindow,
        to: targetLog.timestamp + timeWindow,
      },
      {
        limit: 1000,
      },
    );

    // Filter in-memory by correlation keys
    for (const log of result.logs) {
      if (log.id === targetLog.id) {
        continue;
      } // Skip self

      const logKeys = extractCorrelationKeys(log);

      // Match any correlation key
      if (
        (correlationKeys.requestId &&
          logKeys.requestId === correlationKeys.requestId) ||
        (correlationKeys.traceId &&
          logKeys.traceId === correlationKeys.traceId) ||
        (correlationKeys.executionId &&
          logKeys.executionId === correlationKeys.executionId) ||
        (correlationKeys.sessionId &&
          logKeys.sessionId === correlationKeys.sessionId)
      ) {
        relatedLogs.push(log);
      }
    }

    if (relatedLogs.length > 0) {
      return relatedLogs
        .sort((a, b) => a.timestamp - b.timestamp)
        .map(toFrontendLogRecord);
    }
  }

  // Strategy 2: Fallback to time window + same source
  const result = await platform.logs.query(
    {
      source: targetLog.source,
      from: targetLog.timestamp - timeWindow,
      to: targetLog.timestamp + timeWindow,
    },
    {
      limit: 50,
    },
  );

  return result.logs
    .filter((log) => log.id !== targetLog.id)
    .sort((a, b) => a.timestamp - b.timestamp)
    .map(toFrontendLogRecord);
}

/**
 * Generate fallback summary when LLM is unavailable
 */
function generateFallbackSummary(
  stats: LogStats,
  logs: FrontendLogRecord[],
): string {
  let summary = `Log Summary\n\n`;

  summary += `Total Logs: ${stats.total}\n\n`;

  // Level breakdown
  summary += `By Level:\n`;
  Object.entries(stats.byLevel).forEach(([level, count]) => {
    summary += `${level}: ${count}\n`;
  });
  summary += `\n`;

  // Plugin breakdown
  if (Object.keys(stats.byPlugin).length > 0) {
    summary += `By Plugin:\n`;
    Object.entries(stats.byPlugin)
      .sort(
        (a: [string, unknown], b: [string, unknown]) =>
          (b[1] as number) - (a[1] as number),
      )
      .slice(0, 5)
      .forEach(([plugin, count]) => {
        summary += `${plugin}: ${count}\n`;
      });
    summary += `\n`;
  }

  // Top errors
  if (stats.topErrors.length > 0) {
    summary += `Top Errors:\n`;
    stats.topErrors.slice(0, 5).forEach((err: TopError, idx: number) => {
      summary += `${idx + 1}. "${err.message}" (${err.count} times)\n`;
    });
    summary += `\n`;
  }

  // Time range
  if (stats.timeRange.from && stats.timeRange.to) {
    summary += `Time Range: ${stats.timeRange.from} to ${stats.timeRange.to}\n\n`;
  }

  summary += `Note: LLM summarization is not available. This is a basic statistical summary.`;

  return summary;
}

/**
 * Register log observability routes
 */
export async function registerLogRoutes(
  server: FastifyInstance,
): Promise<void> {
  /**
   * GET /api/v1/logs
   * Query logs with filters
   */
  server.get<{
    Querystring: {
      from?: string;
      to?: string;
      level?: string;
      plugin?: string;
      executionId?: string;
      tenantId?: string;
      search?: string;
      limit?: string;
      offset?: string;
    };
  }>(
    "/api/v1/logs",
    { config: { uxFixture: { validResult: 'error-envelope' } }, schema: { tags: ["Logs"], summary: "Query logs with filters", querystring: logQuerySchema, response: withUxErrorResponses({ 200: { type: 'object', properties: { ok: { const: true }, data: { type: 'object', properties: { logs: { type: 'array', items: logRecordSchema }, total: { type: 'integer' }, hasMore: { type: 'boolean' }, filters: { type: 'object', properties: { level: { type: 'string' }, plugin: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, search: { type: 'string' }, limit: { type: 'string' }, offset: { type: 'string' } }, additionalProperties: false }, source: { type: 'string' }, stats: { type: 'object', properties: { buffer: { type: 'object', properties: { size: { type: 'integer' }, maxSize: { type: 'integer' }, oldest: { type: 'string' }, newest: { type: 'string' } }, required: ['size', 'maxSize'], additionalProperties: false }, persistence: { type: 'object', properties: { totalLogs: { type: 'integer' }, oldestTimestamp: { type: 'string' }, newestTimestamp: { type: 'string' }, sizeBytes: { type: 'integer' } }, required: ['totalLogs', 'sizeBytes'], additionalProperties: false } }, additionalProperties: false } }, required: ['logs', 'total', 'hasMore', 'filters', 'stats'], additionalProperties: false } }, required: ['ok', 'data'], additionalProperties: false } }) } },
    async (request, reply) => {
      try {
        // Parse numeric query params (Fastify doesn't parse them automatically)
        const limit = request.query.limit
          ? parseInt(request.query.limit, 10)
          : 100;
        const offset = request.query.offset
          ? parseInt(request.query.offset, 10)
          : 0;

        // Build query from request params
        const query: LogQuery = {
          level: request.query.level as LogLevel,
          source: request.query.plugin,
          from: request.query.from
            ? new Date(request.query.from).getTime()
            : undefined,
          to: request.query.to
            ? new Date(request.query.to).getTime()
            : undefined,
        };

        // Query logs using unified service
        let result;
        if (request.query.search) {
          // Use full-text search if search query provided
          result = await platform.logs.search(request.query.search, {
            limit,
            offset,
          });
        } else {
          // Regular query with filters
          result = await platform.logs.query(query, {
            limit,
            offset,
          });
        }

        // Convert to frontend format
        const frontendLogs = result.logs.map(toFrontendLogRecord);

        // Get stats for response metadata
        const stats = await platform.logs.getStats();

        return {
          ok: true,
          data: {
            logs: frontendLogs,
            total: result.total,
            hasMore: result.hasMore,
            filters: request.query,
            source: "source" in result ? result.source : undefined,
            stats: {
              buffer: stats.buffer
                ? {
                    size: stats.buffer.size,
                    maxSize: stats.buffer.maxSize,
                    oldest: stats.buffer.oldestTimestamp
                      ? new Date(stats.buffer.oldestTimestamp).toISOString()
                      : undefined,
                    newest: stats.buffer.newestTimestamp
                      ? new Date(stats.buffer.newestTimestamp).toISOString()
                      : undefined,
                  }
                : undefined,
              persistence: stats.persistence
                ? {
                    totalLogs: stats.persistence.totalLogs,
                    oldestTimestamp: stats.persistence.oldestTimestamp
                      ? new Date(
                          stats.persistence.oldestTimestamp,
                        ).toISOString()
                      : undefined,
                    newestTimestamp: stats.persistence.newestTimestamp
                      ? new Date(
                          stats.persistence.newestTimestamp,
                        ).toISOString()
                      : undefined,
                    sizeBytes: stats.persistence.sizeBytes,
                  }
                : undefined,
            },
          },
        };
      } catch (error: unknown) {
        return reply.code(503).send({
          ok: false,
          error: "Log query failed",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

  /**
   * GET /api/v1/logs/:id
   * Get single log by ID with related logs
   */
  server.get<{
    Params: { id: string };
    Querystring: { includeRelated?: string };
  }>(
    "/api/v1/logs/:id",
    { config: { uxFixture: { validResult: 'error-envelope' } }, schema: { tags: ["Logs"], summary: "Get log entry by ID", params: { type: 'object', properties: { id: { type: 'string', minLength: 1 } }, required: ['id'], additionalProperties: false }, querystring: { type: 'object', properties: { includeRelated: { enum: ['true', 'false'] } }, additionalProperties: false }, response: withUxErrorResponses({ 200: { type: 'object', properties: { ok: { const: true }, data: { type: 'object', properties: { log: logRecordSchema, related: { type: 'array', items: logRecordSchema } }, required: ['log'], additionalProperties: false } }, required: ['ok', 'data'], additionalProperties: false } }) } },
    async (request, reply) => {
      try {
        const log = await platform.logs.getById(request.params.id);

        if (!log) {
          return reply.code(404).send({
            ok: false,
            error: "Log not found",
            message: `Log with ID '${request.params.id}' does not exist`,
          });
        }

        const frontendLog = toFrontendLogRecord(log);

        // Optionally include related logs
        let relatedLogs: FrontendLogRecord[] = [];
        if (request.query.includeRelated === "true") {
          relatedLogs = await findRelatedLogs(log);
        }

        return {
          ok: true,
          data: {
            log: frontendLog,
            related: relatedLogs.length > 0 ? relatedLogs : undefined,
          },
        };
      } catch (error: unknown) {
        return reply.code(500).send({
          ok: false,
          error: "Failed to fetch log",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

  /**
   * GET /api/v1/logs/:id/related
   * Get logs related to a specific log (same trace/execution/request)
   */
  server.get<{ Params: { id: string } }>(
    "/api/v1/logs/:id/related",
    {
      config: { uxFixture: { validResult: 'error-envelope' } },
      schema: {
        tags: ["Logs"],
        summary: "Get logs related to a specific entry",
        params: { type: 'object', properties: { id: { type: 'string', minLength: 1 } }, required: ['id'], additionalProperties: false },
        querystring: { type: 'object', additionalProperties: false },
        response: withUxErrorResponses({ 200: { type: 'object', properties: { ok: { const: true }, data: { type: 'object', properties: { total: { type: 'integer' }, logs: { type: 'array', items: logRecordSchema }, correlationKeys: { type: 'object' } }, required: ['total', 'logs', 'correlationKeys'], additionalProperties: false } }, required: ['ok', 'data'], additionalProperties: false } }),
      },
    },
    async (request, reply) => {
      try {
        const log = await platform.logs.getById(request.params.id);

        if (!log) {
          return reply.code(404).send({
            ok: false,
            error: "Log not found",
            message: `Log with ID '${request.params.id}' does not exist`,
          });
        }

        const relatedLogs = await findRelatedLogs(log);

        return {
          ok: true,
          data: {
            total: relatedLogs.length,
            logs: relatedLogs,
            correlationKeys: extractCorrelationKeys(log),
          },
        };
      } catch (error: unknown) {
        return reply.code(500).send({
          ok: false,
          error: "Failed to fetch related logs",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

  /**
   * GET /api/v1/logs/stream
   * Server-Sent Events stream for real-time logs
   */
  server.get(
    "/api/v1/logs/stream",
    { config: { ux: 'raw' }, schema: { hide: true, querystring: { type: 'object', additionalProperties: false } } },
    async (request, reply) => {
      // Check if streaming is supported
      const caps = platform.logs.getCapabilities();
      if (!caps.hasStreaming) {
        return reply.code(503).send({
          error: "Log streaming not enabled",
          message:
            "Logger adapter does not support streaming. Enable logRingBuffer in kb.config.json",
        });
      }

      // Explicit CORS headers for EventSource
      const origin = request.headers.origin;
      const stream = createSseStream(request, reply, {
        logger: request.kbLogger ?? platform.logger,
        serviceId: "rest",
        route: "/api/v1/logs/stream",
        // This stream carries logs, so event-level telemetry would feed it
        // back into itself. Lifecycle + close summary remain enabled.
        logEvents: false,
        headers: origin === "http://localhost:3000" || origin === "http://localhost:5173"
          ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true" }
          : { "Access-Control-Allow-Origin": "*" },
      });

      // Subscribe to log stream using unified service
      const unsubscribe = platform.logs.subscribe((log) => {
        // Frontend expects event name 'log'. Do not emit per-event telemetry:
        // otherwise this log stream would subscribe to its own telemetry.
        stream.send("log", toFrontendLogRecord(log));
      });
      stream.onCleanup(unsubscribe);
      await stream.closed;
    },
  );

  /**
   * GET /api/v1/logs/stats
   * Get combined log statistics from all backends
   */
  server.get(
    "/api/v1/logs/stats",
    { schema: { tags: ["Logs"], summary: "Get log storage statistics", querystring: { type: 'object', additionalProperties: false }, response: withUxErrorResponses({ 200: { type: 'object', properties: { ok: { const: true }, data: { type: 'object', properties: { capabilities: { type: 'object', properties: { hasBuffer: { type: 'boolean' }, hasPersistence: { type: 'boolean' }, hasSearch: { type: 'boolean' }, hasStreaming: { type: 'boolean' } }, required: ['hasBuffer', 'hasPersistence', 'hasSearch', 'hasStreaming'], additionalProperties: false }, buffer: { type: 'object', properties: { size: { type: 'integer' }, maxSize: { type: 'integer' }, oldest: { type: 'string', format: 'date-time' }, newest: { type: 'string', format: 'date-time' } }, required: ['size', 'maxSize'], additionalProperties: false }, persistence: { type: 'object', properties: { totalLogs: { type: 'integer' }, oldest: { type: 'string', format: 'date-time' }, newest: { type: 'string', format: 'date-time' }, sizeBytes: { type: 'integer' } }, required: ['totalLogs', 'sizeBytes'], additionalProperties: false } }, required: ['capabilities'], additionalProperties: false } }, required: ['ok', 'data'], additionalProperties: false } }) } },
    async (request, reply) => {
      try {
        const stats = await platform.logs.getStats();
        const caps = platform.logs.getCapabilities();

        return {
          ok: true,
          data: {
            capabilities: caps,
            buffer: stats.buffer
              ? {
                  size: stats.buffer.size,
                  maxSize: stats.buffer.maxSize,
                  oldest: stats.buffer.oldestTimestamp
                    ? new Date(stats.buffer.oldestTimestamp).toISOString()
                    : undefined,
                  newest: stats.buffer.newestTimestamp
                    ? new Date(stats.buffer.newestTimestamp).toISOString()
                    : undefined,
                }
              : undefined,
            persistence: stats.persistence
              ? {
                  totalLogs: stats.persistence.totalLogs,
                  oldest: stats.persistence.oldestTimestamp
                    ? new Date(stats.persistence.oldestTimestamp).toISOString()
                    : undefined,
                  newest: stats.persistence.newestTimestamp
                    ? new Date(stats.persistence.newestTimestamp).toISOString()
                    : undefined,
                  sizeBytes: stats.persistence.sizeBytes,
                }
              : undefined,
          },
        };
      } catch (error: unknown) {
        return reply.code(500).send({
          ok: false,
          error: "Failed to fetch stats",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

  /**
   * POST /api/v1/logs/summarize
   * AI-powered log summarization (placeholder for future implementation)
   *
   * Expected request body:
   * {
   *   "timeRange": { "from": "ISO timestamp", "to": "ISO timestamp" },
   *   "filters": { "level": "error", "plugin": "rest", "traceId": "..." },
   *   "groupBy": "trace" | "execution" | "plugin",
   *   "question": "What happened in the last 5 minutes?" (optional)
   * }
   */
  server.post<{
    Body: {
      timeRange?: { from?: string; to?: string };
      filters?: {
        level?: string;
        plugin?: string;
        traceId?: string;
        executionId?: string;
      };
      groupBy?: "trace" | "execution" | "plugin";
      question?: string;
      includeContext?: {
        errors?: boolean;
        warnings?: boolean;
        info?: boolean;
        metadata?: boolean;
        stackTraces?: boolean;
      };
    };
  }>(
    "/api/v1/logs/summarize",
    { config: { uxFixture: { validResult: 'error-envelope' } }, schema: { tags: ["Logs"], summary: "AI-powered log summarization", querystring: { type: 'object', additionalProperties: false }, body: { type: 'object', properties: { timeRange: { type: 'object', properties: { from: { type: 'string', format: 'date-time' }, to: { type: 'string', format: 'date-time' } }, additionalProperties: false }, filters: { type: 'object', properties: { level: { type: 'string' }, plugin: { type: 'string' }, traceId: { type: 'string' }, executionId: { type: 'string' } }, additionalProperties: false }, groupBy: { enum: ['trace', 'execution', 'plugin'] }, question: { type: 'string' }, includeContext: { type: 'object', properties: { errors: { type: 'boolean' }, warnings: { type: 'boolean' }, info: { type: 'boolean' }, metadata: { type: 'boolean' }, stackTraces: { type: 'boolean' } }, additionalProperties: false } }, additionalProperties: false }, response: withUxErrorResponses({ 200: { type: 'object', properties: { ok: { const: true }, data: { type: 'object', properties: { summary: { type: 'object', properties: { question: { type: 'string' }, timeRange: { type: 'object', properties: { from: { type: ['string', 'null'] }, to: { type: ['string', 'null'] } }, required: ['from', 'to'], additionalProperties: false }, total: { type: 'integer' }, stats: { type: 'object' }, groups: { type: ['object', 'null'] } }, required: ['question', 'timeRange', 'total', 'stats'], additionalProperties: false }, aiSummary: { type: ['string', 'null'] }, message: { type: ['string', 'null'] } }, required: ['summary', 'aiSummary', 'message'], additionalProperties: false } }, required: ['ok', 'data'], additionalProperties: false } }) } },
    async (request, reply) => {
      const { timeRange, filters, groupBy, question, includeContext } =
        request.body;

      try {
        // Build query from request
        const query: LogQuery = {
          level: filters?.level as LogLevel,
          source: filters?.plugin,
          from: timeRange?.from
            ? new Date(timeRange.from).getTime()
            : undefined,
          to: timeRange?.to ? new Date(timeRange.to).getTime() : undefined,
        };

        // Query logs using unified service
        const result = await platform.logs.query(query, { limit: 1000 });
        const frontendLogs = result.logs.map(toFrontendLogRecord);

        // Additional filters (traceId, executionId)
        let filteredLogs = frontendLogs;
        if (filters?.traceId) {
          filteredLogs = filteredLogs.filter(
            (log) => log.traceId === filters.traceId,
          );
        }
        if (filters?.executionId) {
          filteredLogs = filteredLogs.filter(
            (log) => log.executionId === filters.executionId,
          );
        }

        // Calculate aggregated statistics
        const stats = {
          total: filteredLogs.length,
          byLevel: {} as Record<string, number>,
          byPlugin: {} as Record<string, number>,
          topErrors: [] as Array<{ message: string; count: number }>,
          timeRange: {
            from: filteredLogs.length > 0 ? filteredLogs[0]!.time : null,
            to:
              filteredLogs.length > 0
                ? filteredLogs[filteredLogs.length - 1]!.time
                : null,
          },
        };

        const errorMessages = new Map<string, number>();

        for (const log of filteredLogs) {
          // Count by level
          stats.byLevel[log.level] = (stats.byLevel[log.level] || 0) + 1;

          // Count by plugin
          if (log.plugin) {
            stats.byPlugin[log.plugin] = (stats.byPlugin[log.plugin] || 0) + 1;
          }

          // Track error messages
          if (log.level === "error" && log.msg) {
            errorMessages.set(log.msg, (errorMessages.get(log.msg) || 0) + 1);
          }
        }

        // Top 10 errors
        stats.topErrors = Array.from(errorMessages.entries())
          .map(([message, count]) => ({ message, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 10);

        // Group logs if requested
        let groups: Record<string, FrontendLogRecord[]> | null = null;
        if (groupBy) {
          // Map frontend groupBy values to actual log field names
          const fieldMap: Record<string, string> = {
            trace: "traceId",
            execution: "executionId",
            plugin: "plugin",
          };

          const groupMap = new Map<string, FrontendLogRecord[]>();
          for (const log of filteredLogs) {
            const fieldName = fieldMap[groupBy] || groupBy;
            const key = String(log[fieldName] || "unknown");
            if (!groupMap.has(key)) {
              groupMap.set(key, []);
            }
            groupMap.get(key)!.push(log);
          }
          groups = Object.fromEntries(groupMap.entries());
        }

        // AI Summarization
        let aiSummary: string | null = null;
        let message: string | null = null;

        if (platform.llm && question) {
          try {
            const context = includeContext || {
              errors: true,
              warnings: true,
              info: false,
              metadata: true,
              stackTraces: true,
            };

            const prompt = buildLogSummaryPrompt(
              question,
              filteredLogs,
              stats,
              context,
            );

            const response = await platform.llm.complete(prompt, {
              temperature: 0.7,
              maxTokens: 1000,
              systemPrompt:
                "You are a technical log analysis assistant. Provide clear, actionable insights based on application logs.",
            });

            aiSummary = response.content.trim();
          } catch (error) {
            // Graceful degradation
            platform.logger.warn("LLM summarization failed, using fallback", {
              error: error instanceof Error ? error.message : String(error),
            });
            aiSummary = generateFallbackSummary(stats, filteredLogs);
            message =
              "AI summarization unavailable, showing statistical summary";
          }
        } else {
          // No LLM or no question - return fallback
          aiSummary = generateFallbackSummary(stats, filteredLogs);
          message = platform.llm
            ? "No question provided"
            : "LLM not configured";
        }

        // Return structured data with AI summary
        return {
          ok: true,
          data: {
            summary: {
              question: question || "General log summary",
              timeRange: stats.timeRange,
              total: stats.total,
              stats,
              groups,
            },
            aiSummary,
            message,
          },
        };
      } catch (error: unknown) {
        return reply.code(500).send({
          ok: false,
          error: "Log summarization failed",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );
}
