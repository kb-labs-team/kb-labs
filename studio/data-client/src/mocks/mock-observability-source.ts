/**
 * @module @kb-labs/studio-data-client/mocks/mock-observability-source
 * Mock implementation of ObservabilityDataSource
 */

import type { ObservabilityDataSource } from '../sources/observability-source';
import type {
  StateBrokerStats,
  DevKitHealth,
  PrometheusMetrics,
  SystemEvent,
  LogRecord,
  LogQuery,
  LogQueryResponse,
  LogSummarizeRequest,
  LogSummarizeResponse,
  HistoricalDataPoint,
  HeatmapCell,
  MetricsHistoryQuery,
  MetricsHeatmapQuery,
  Incident,
  IncidentQuery,
  IncidentCreatePayload,
  IncidentsListResponse,
  IncidentDetailResponse,
  IncidentAnalysisResponse,
} from '../contracts/observability';

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(() => resolve(), ms);
  });
}

/**
 * Mock implementation of ObservabilityDataSource
 *
 * Returns deterministic mock data for development and testing
 */
export class MockObservabilitySource implements ObservabilityDataSource {
  async getStateBrokerStats(): Promise<StateBrokerStats> {
    await delay(150);

    return {
      uptime: 3_600_000, // 1 hour
      totalEntries: 42,
      totalSize: 10_240, // 10KB
      hitRate: 0.85,
      missRate: 0.15,
      evictions: 5,
      namespaces: {
        mind: {
          entries: 20,
          hits: 100,
          misses: 10,
          size: 5_120,
        },
        workflow: {
          entries: 15,
          hits: 80,
          misses: 5,
          size: 3_072,
        },
        plugin: {
          entries: 7,
          hits: 30,
          misses: 2,
          size: 2_048,
        },
      },
    };
  }

  async getDevKitHealth(): Promise<DevKitHealth> {
    await delay(200);

    return {
      healthScore: 68,
      grade: 'D',
      issues: {
        duplicateDeps: 30,
        missingReadmes: 12,
        typeErrors: 3012,
        brokenImports: 5,
        unusedExports: 120,
      },
      packages: 91,
      avgTypeCoverage: 91.1,
    };
  }

  async getPrometheusMetrics(): Promise<PrometheusMetrics> {
    await delay(180);

    const now = Date.now();
    const startTime = now - 7_200_000; // 2 hours ago

    return {
      requests: {
        total: 1542,
        success: 1489,
        clientErrors: 38,
        serverErrors: 15,
      },
      latency: {
        average: 47.3,
        min: 3.2,
        max: 892.5,
        p50: 38.1,
        p95: 125.7,
        p99: 287.4,
      },
      perPlugin: [
        {
          pluginId: 'workflow',
          requests: 523,
          errors: 12,
          latency: {
            average: 52.1,
            min: 5.3,
            max: 345.2,
          },
        },
        {
          pluginId: 'mind',
          requests: 387,
          errors: 8,
          latency: {
            average: 68.5,
            min: 12.1,
            max: 892.5,
          },
        },
        {
          pluginId: 'commit',
          requests: 142,
          errors: 3,
          latency: {
            average: 35.2,
            min: 8.7,
            max: 156.3,
          },
        },
      ],
      perTenant: [
        {
          tenantId: 'default',
          requests: 1542,
          errors: 53,
          latency: {
            average: 47.3,
          },
        },
      ],
      errors: {
        byStatusCode: {
          400: 12,
          404: 18,
          422: 8,
          500: 10,
          503: 5,
        },
        recent: [
          {
            timestamp: now - 120_000,
            statusCode: 500,
            errorCode: 'INTERNAL_ERROR',
            message: 'Database connection timeout',
          },
          {
            timestamp: now - 300_000,
            statusCode: 404,
            message: 'Resource not found',
          },
          {
            timestamp: now - 450_000,
            statusCode: 422,
            errorCode: 'VALIDATION_ERROR',
            message: 'Invalid request payload',
          },
        ],
      },
      timestamps: {
        startTime,
        lastRequest: now - 2_500,
      },
      redis: {
        updates: 342,
        healthyTransitions: 2,
        unhealthyTransitions: 1,
        lastStatus: {
          healthy: true,
          state: 'ready',
          role: 'master',
        },
      },
      pluginMounts: {
        total: 8,
        succeeded: 7,
        failed: 1,
        elapsedMs: 1247,
      },
      uptime: {
        seconds: 7200,
        startTime: new Date(startTime).toISOString(),
        lastRequest: new Date(now - 2_500).toISOString(),
      },
    };
  }

  async queryLogs(filters: LogQuery): Promise<LogQueryResponse> {
    await delay(200);

    const now = Date.now();
    const oldest = new Date(now - 3_600_000).toISOString(); // 1 hour ago
    const newest = new Date(now).toISOString();

    // Generate mock log records
    const mockLogs: LogRecord[] = Array.from({ length: filters.limit || 20 }, (_, i) => ({
      time: new Date(now - i * 60_000).toISOString(),
      level: ['info', 'warn', 'error'][i % 3] as 'info' | 'warn' | 'error',
      msg: `Mock log entry ${i + 1}`,
      plugin: filters.plugin || ['rest-api', 'workflow', 'mind'][i % 3],
      executionId: filters.executionId || `exec-${i}`,
      tenantId: filters.tenantId || 'default',
      meta: { mockData: true, index: i },
    }));

    return {
      ok: true,
      data: {
        logs: mockLogs,
        total: 42,
        filters,
        bufferStats: {
          size: mockLogs.length,
          maxSize: 1000,
          oldest,
          newest,
        },
      },
    };
  }

  subscribeToSystemEvents(
    onEvent: (event: SystemEvent) => void,
    _onError: (error: Error) => void
  ): () => void {
    // Simulate periodic events in mock mode
    const interval = setInterval(() => {
      const now = Date.now();

      // Alternate between health and registry events
      if (Math.random() > 0.5) {
        onEvent({
          type: 'health',
          status: 'healthy',
          ts: new Date(now).toISOString(),
          ready: true,
          reason: null,
          registryPartial: false,
          registryStale: false,
          registryLoaded: true,
          pluginMountInProgress: false,
          pluginRoutesMounted: true,
          pluginsMounted: 7,
          pluginsFailed: 1,
          lastPluginMountTs: new Date(now - 60000).toISOString(),
          pluginRoutesLastDurationMs: 1247,
          redisEnabled: true,
          redisHealthy: true,
        });
      } else {
        onEvent({
          type: 'registry',
          rev: Math.random().toString(36).substring(7),
          generatedAt: new Date(now).toISOString(),
          partial: false,
          stale: false,
          expiresAt: new Date(now + 300000).toISOString(),
          ttlMs: 300000,
          checksum: Math.random().toString(36).substring(2, 15),
          checksumAlgorithm: 'sha256',
          previousChecksum: null,
        });
      }
    }, 3000); // Event every 3 seconds

    // Return cleanup function
    return () => {
      clearInterval(interval);
    };
  }

  subscribeToLogs(
    onLog: (log: LogRecord) => void,
    _onError: (error: Error) => void,
    filters?: LogQuery
  ): () => void {
    // Simulate periodic log events in mock mode
    let counter = 0;
    const interval = setInterval(() => {
      const now = Date.now();
      onLog({
        time: new Date(now).toISOString(),
        level: ['info', 'warn', 'error'][counter % 3] as 'info' | 'warn' | 'error',
        msg: `Mock live log ${counter + 1}`,
        plugin: filters?.plugin || ['rest-api', 'workflow', 'mind'][counter % 3],
        executionId: filters?.executionId || `exec-${counter}`,
        tenantId: filters?.tenantId || 'default',
        meta: { mockData: true, counter },
      });
      counter++;
    }, 2000); // Log every 2 seconds

    // Return cleanup function
    return () => {
      clearInterval(interval);
    };
  }

  async getLog(_id: string, includeRelated?: boolean): Promise<{ log: LogRecord; related?: LogRecord[] }> {
    await delay(200);

    const now = Date.now();
    const mockLog: LogRecord = {
      id: _id,
      time: new Date(now - 120_000).toISOString(), // 2 minutes ago
      level: 'error',
      msg: `Mock log entry with id ${_id}`,
      plugin: 'rest-api',
      executionId: `exec-${_id}`,
      tenantId: 'default',
      requestId: `req-${_id}`,
      traceId: `trace-${_id}`,
      err: {
        name: 'MockError',
        message: 'This is a mock error for demonstration',
        stack: `MockError: This is a mock error for demonstration\n    at mockFunction (mock.ts:42)\n    at handler (handler.ts:89)\n    at process (process.ts:123)`,
      },
      meta: { mockData: true },
    };

    let related: LogRecord[] | undefined;
    if (includeRelated) {
      // Generate mock related logs
      related = Array.from({ length: 3 }, (_, i) => ({
        id: `${_id}-related-${i}`,
        time: new Date(now - (120_000 + i * 1000)).toISOString(),
        level: ['info', 'debug', 'error'][i % 3] as 'info' | 'debug' | 'error',
        msg: `Mock related log ${i + 1}`,
        plugin: 'rest-api',
        executionId: mockLog.executionId,
        requestId: mockLog.requestId,
        traceId: mockLog.traceId,
        meta: { mockData: true, relatedIndex: i },
      }));
    }

    return { log: mockLog, related };
  }

  async getRelatedLogs(_id: string): Promise<{ total: number; logs: LogRecord[]; correlationKeys: any }> {
    await delay(150);

    const now = Date.now();
    const mockLogs: LogRecord[] = Array.from({ length: 5 }, (_, i) => ({
      id: `${_id}-related-${i}`,
      time: new Date(now - (120_000 + i * 1000)).toISOString(),
      level: ['info', 'debug', 'warn', 'error'][i % 4] as 'info' | 'debug' | 'warn' | 'error',
      msg: `Mock related log ${i + 1}`,
      plugin: 'rest-api',
      executionId: `exec-${_id}`,
      requestId: `req-${_id}`,
      traceId: `trace-${_id}`,
      meta: { mockData: true, relatedIndex: i },
    }));

    return {
      total: mockLogs.length,
      logs: mockLogs,
      correlationKeys: {
        requestId: `req-${_id}`,
        traceId: `trace-${_id}`,
        executionId: `exec-${_id}`,
      },
    };
  }

  async summarizeLogs(request: LogSummarizeRequest): Promise<LogSummarizeResponse> {
    await delay(1500); // Simulate LLM processing time

    return {
        summary: {
          question: request.question,
          timeRange: {
            from: request.timeRange?.from || null,
            to: request.timeRange?.to || null,
          },
          total: 42,
          stats: {
            total: 42,
            byLevel: {
              error: 3,
              warn: 5,
              info: 34,
            },
            byPlugin: {
              'rest-api': 20,
              'workflow': 15,
              'mind': 7,
            },
            topErrors: [
              { message: 'Connection timeout', count: 2 },
              { message: 'Invalid parameter', count: 1 },
            ],
            timeRange: {
              from: request.timeRange?.from || null,
              to: request.timeRange?.to || null,
            },
          },
          groups: null,
        },
        aiSummary: `## Mock AI Summary

Based on the analysis of ${42} log entries:

**Key Findings:**
- Total of 3 errors and 5 warnings detected
- Most active component: rest-api (20 logs)
- Primary issue: Connection timeouts (2 occurrences)

**Timeline:**
The system has been mostly stable with info-level logs. Two connection timeout errors were observed, likely related to external service availability.

**Recommendations:**
1. Investigate network connectivity to external services
2. Consider implementing retry logic with exponential backoff
3. Monitor timeout patterns over next 24 hours

*Note: This is mock data from MockObservabilitySource*`,
        message: null,
    };
  }

  async getMetricsHistory(query: MetricsHistoryQuery): Promise<HistoricalDataPoint[]> {
    await delay(100);

    // Generate mock time-series data
    const now = Date.now();
    const rangeMs = {
      '1m': 60 * 1000,
      '5m': 5 * 60 * 1000,
      '10m': 10 * 60 * 1000,
      '30m': 30 * 60 * 1000,
      '1h': 60 * 60 * 1000,
    }[query.range];

    const intervalMs = query.interval === '1m' ? 60 * 1000 : query.interval === '5m' ? 5 * 60 * 1000 : 5000;
    const points: HistoricalDataPoint[] = [];

    for (let t = now - rangeMs; t <= now; t += intervalMs) {
      let value = 0;

      switch (query.metric) {
        case 'requests':
          value = 100 + Math.floor(Math.random() * 50);
          break;
        case 'errors':
          value = Math.floor(Math.random() * 5);
          break;
        case 'latency':
          value = 30 + Math.floor(Math.random() * 20);
          break;
        case 'uptime':
          value = (now - t) / 1000;
          break;
      }

      points.push({ timestamp: t, value });
    }

    return points;
  }

  async getMetricsHeatmap(query: MetricsHeatmapQuery): Promise<HeatmapCell[]> {
    await delay(150);

    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const cells: HeatmapCell[] = [];

    for (const day of days) {
      for (let hour = 0; hour < 24; hour++) {
        cells.push({ day, hour, value: mockHeatmapValue(query.metric, hour) });
      }
    }

    return cells;
  }

  async queryIncidents(query?: IncidentQuery): Promise<Incident[]> {
    await delay(200);

    const mockIncidents: Incident[] = [
      {
        id: 'inc-1',
        type: 'latency_spike',
        severity: 'warning',
        title: 'Elevated API Latency',
        details: 'Average latency increased to 250ms (baseline: 50ms)',
        rootCause: [
          {
            factor: 'Database connection pool exhaustion',
            confidence: 0.85,
            evidence: 'Connection pool utilization at 100%, wait queue growing',
          },
          {
            factor: 'Increased query complexity',
            confidence: 0.6,
            evidence: 'Average query time increased 3x in the last hour',
          },
        ],
        affectedServices: ['rest-api', 'workflow-runtime'],
        timestamp: Date.now() - 2 * 60 * 60 * 1000, // 2 hours ago
        resolvedAt: Date.now() - 1 * 60 * 60 * 1000, // 1 hour ago
        resolutionNotes: 'Increased connection pool size from 10 to 20',
        metadata: { peakLatency: 350, duration: '45m' },
      },
      {
        id: 'inc-2',
        type: 'error_rate',
        severity: 'critical',
        title: 'High Error Rate in Mind Plugin',
        details: 'Error rate spiked to 15% (baseline: <1%)',
        affectedServices: ['mind-engine'],
        timestamp: Date.now() - 30 * 60 * 1000, // 30 minutes ago
        metadata: { errorCount: 47, requestCount: 310 },
      },
      {
        id: 'inc-3',
        type: 'plugin_failure',
        severity: 'warning',
        title: 'Plugin Mount Timeout',
        details: 'workflow plugin took 15s to mount (expected: <3s)',
        affectedServices: ['workflow-runtime'],
        timestamp: Date.now() - 10 * 60 * 1000, // 10 minutes ago
        resolvedAt: Date.now() - 5 * 60 * 1000, // 5 minutes ago
        resolutionNotes: 'Plugin restarted successfully',
      },
    ];

    // Apply filters
    let filtered = [...mockIncidents];

    if (query?.severity) {
      const severityList = Array.isArray(query.severity) ? query.severity : [query.severity];
      filtered = filtered.filter(inc => severityList.includes(inc.severity));
    }

    if (query?.type) {
      const typeList = Array.isArray(query.type) ? query.type : [query.type];
      filtered = filtered.filter(inc => typeList.includes(inc.type));
    }

    if (query?.from) {
      filtered = filtered.filter(inc => inc.timestamp >= query.from!);
    }

    if (query?.to) {
      filtered = filtered.filter(inc => inc.timestamp <= query.to!);
    }

    if (!query?.includeResolved) {
      filtered = filtered.filter(inc => !inc.resolvedAt);
    }

    if (query?.limit) {
      filtered = filtered.slice(0, query.limit);
    }

    return filtered;
  }

  async createIncident(payload: IncidentCreatePayload): Promise<Incident> {
    await delay(150);

    const incident: Incident = {
      id: `inc-${Date.now()}`,
      ...payload,
      timestamp: payload.timestamp || Date.now(),
    };

    return incident;
  }

  async resolveIncident(_id: string, resolutionNotes?: string): Promise<Incident> {
    await delay(150);

    // Mock resolving an incident
    const incident: Incident = {
      id: _id,
      type: 'error_rate',
      severity: 'critical',
      title: 'Mock Incident',
      details: 'Mock incident details',
      timestamp: Date.now() - 60 * 60 * 1000,
      resolvedAt: Date.now(),
      resolutionNotes,
    };

    return incident;
  }

  async listIncidents(query?: IncidentQuery): Promise<IncidentsListResponse> {
    await delay(150);

    const incidents = await this.queryIncidents(query);
    const unresolved = incidents.filter(i => !i.resolvedAt).length;

    return {
      ok: true,
      data: {
        incidents,
        summary: {
          total: incidents.length,
          unresolved,
          bySeverity: {
            critical: incidents.filter(i => i.severity === 'critical').length,
            warning: incidents.filter(i => i.severity === 'warning').length,
            info: incidents.filter(i => i.severity === 'info').length,
          },
          showing: incidents.length,
        },
      },
    };
  }

  async getIncident(_id: string): Promise<IncidentDetailResponse> {
    await delay(150);

    const incident: Incident = {
      id: _id,
      type: 'error_rate',
      severity: 'critical',
      title: 'High Error Rate Detected',
      details: 'Error rate exceeded threshold of 10%',
      timestamp: Date.now() - 60 * 60 * 1000,
      affectedServices: ['rest-api', 'workflow-engine'],
      metadata: {
        errorRate: 15.2,
        threshold: 10,
      },
      relatedData: {
        logs: {
          errorCount: 42,
          warnCount: 18,
          timeRange: [Date.now() - 5 * 60 * 1000, Date.now()],
          sampleErrors: [
            'TypeError: Cannot read property \'name\' of undefined',
            'Error: Failed to connect to database',
            'Error: Timeout exceeded for operation',
          ],
        },
        metrics: {
          before: {
            errorRate: 2.1,
            avgLatency: 45,
            totalRequests: 1000,
          },
          during: {
            errorRate: 15.2,
            avgLatency: 120,
            totalRequests: 500,
            totalErrors: 76,
          },
        },
        timeline: [
          {
            timestamp: Date.now(),
            event: 'Incident detected: error_rate',
            source: 'detector',
          },
          {
            timestamp: Date.now() - 2 * 60 * 1000,
            event: 'Error: Failed to connect to database',
            source: 'logs',
          },
          {
            timestamp: Date.now() - 3 * 60 * 1000,
            event: 'Error: Timeout exceeded for operation',
            source: 'logs',
          },
        ],
      },
    };

    return {
      ok: true,
      data: incident,
    };
  }

  async analyzeIncident(_id: string): Promise<IncidentAnalysisResponse> {
    await delay(800); // Simulate LLM processing time

    return {
      ok: true,
      data: {
        summary: 'High error rate detected due to database connection issues and timeout problems. System experienced 15.2% error rate, significantly above the 2.1% baseline.',
        rootCauses: [
          {
            factor: 'Database connection pool exhaustion',
            confidence: 0.85,
            evidence: 'Multiple "Failed to connect to database" errors in logs. Error rate correlation with database connection attempts.',
          },
          {
            factor: 'Increased request timeout frequency',
            confidence: 0.72,
            evidence: 'Timeout errors increased from 0% to 8% during incident window. Latency jumped from 45ms to 120ms.',
          },
          {
            factor: 'Potential memory leak in error handler',
            confidence: 0.45,
            evidence: 'TypeError suggests undefined object access, possibly due to improper error handling initialization.',
          },
        ],
        patterns: [
          'Error rate spike correlates with increased latency (45ms → 120ms)',
          'Database connection errors preceded timeout errors by ~1 minute',
          'Error rate increased 7x above baseline during incident',
        ],
        recommendations: [
          'Increase database connection pool size and implement connection retry logic with exponential backoff',
          'Add circuit breaker pattern to prevent cascading failures when database is unavailable',
          'Review error handling code for undefined object access, especially in database connection error paths',
          'Implement request timeout monitoring and alerting at 75% of threshold',
          'Consider adding database health check endpoint to proactively detect connection issues',
        ],
        analyzedAt: Date.now(),
        cached: false,
      },
    };
  }

  async chatWithInsights(
    question: string,
    context?: {
      includeMetrics?: boolean;
      includeIncidents?: boolean;
      includeHistory?: boolean;
      timeRange?: '1h' | '6h' | '24h' | '7d';
      plugins?: string[];
    }
  ): Promise<{
    answer: string;
    context: string[];
    usage: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    };
  }> {
    await delay(500);

    // Mock AI response
    return {
      answer: `Based on the current system metrics, here's my analysis of "${question}": The system is performing well with average latency of 45ms and 99.2% success rate. No critical issues detected.`,
      context: [
        'Current metrics: 1,234 requests in the last hour',
        'Average latency: 45ms',
        'Error rate: 0.8%',
        context?.includeIncidents ? '2 active incidents' : undefined,
      ].filter(Boolean) as string[],
      usage: {
        promptTokens: 150,
        completionTokens: 80,
        totalTokens: 230,
      },
    };
  }
}

function mockHeatmapValue(metric: string, hour: number): number {
  const isBusinessHour = hour >= 9 && hour <= 17;
  if (metric === 'latency') { return 30 + Math.floor(Math.random() * 40) + (isBusinessHour ? 10 : 0); }
  if (metric === 'errors') { return Math.floor(Math.random() * 10); }
  if (metric === 'requests') { return 50 + Math.floor(Math.random() * 100) + (isBusinessHour ? 50 : 0); }
  return 0;
}
