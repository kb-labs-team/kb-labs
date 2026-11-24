/**
 * @module @kb-labs/studio-data-client/contracts/observability
 * Observability contracts for Studio
 */

/**
 * State Broker statistics
 */
export interface StateBrokerStats {
  /** Daemon uptime in milliseconds */
  uptime: number;

  /** Total number of cache entries */
  totalEntries: number;

  /** Total cache size in bytes */
  totalSize: number;

  /** Cache hit rate (0-1) */
  hitRate: number;

  /** Cache miss rate (0-1) */
  missRate: number;

  /** Number of evicted entries */
  evictions: number;

  /** Stats per namespace */
  namespaces: Record<string, NamespaceStats>;
}

/**
 * Namespace-level statistics
 */
export interface NamespaceStats {
  /** Number of entries */
  entries: number;

  /** Cache hits */
  hits: number;

  /** Cache misses */
  misses: number;

  /** Size in bytes */
  size: number;
}

/**
 * DevKit health snapshot
 */
export interface DevKitHealth {
  /** Health score (0-100) */
  healthScore: number;

  /** Letter grade (A-F) */
  grade: 'A' | 'B' | 'C' | 'D' | 'F';

  /** Issues breakdown */
  issues: {
    duplicateDeps?: number;
    missingReadmes?: number;
    typeErrors?: number;
    brokenImports?: number;
    unusedExports?: number;
    [key: string]: number | undefined;
  };

  /** Total packages */
  packages: number;

  /** Average type coverage percentage */
  avgTypeCoverage?: number;
}

/**
 * Prometheus metrics from REST API
 */
export interface PrometheusMetrics {
  /** Request statistics */
  requests: {
    total: number;
    success: number;
    clientErrors: number;
    serverErrors: number;
  };

  /** Latency statistics */
  latency: {
    average: number;
    min: number;
    max: number;
    p50: number;
    p95: number;
    p99: number;
  };

  /** Per-plugin metrics */
  perPlugin: Array<{ pluginId: string } & PluginMetrics>;

  /** Per-tenant metrics */
  perTenant: Array<{ tenantId: string } & TenantMetrics>;

  /** Error breakdown */
  errors: {
    byStatusCode: Record<number, number>;
    recent: Array<{
      timestamp: number;
      statusCode: number;
      errorCode?: string;
      message: string;
    }>;
  };

  /** Timestamps */
  timestamps: {
    startTime: number;
    lastRequest: number | null;
  };

  /** Redis statistics */
  redis: {
    updates: number;
    healthyTransitions: number;
    unhealthyTransitions: number;
    lastStatus: {
      healthy: boolean;
      state: string;
      role: string;
    } | null;
  };

  /** Plugin mount snapshot */
  pluginMounts: {
    total: number;
    succeeded: number;
    failed: number;
    elapsedMs: number;
  } | null;

  /** Uptime information */
  uptime: {
    seconds: number;
    startTime: string;
    lastRequest: string | null;
  };
}

/**
 * Plugin-level metrics
 */
export interface PluginMetrics {
  requests: number;
  errors: number;
  latency: {
    average: number;
    min: number;
    max: number;
  };
}

/**
 * Tenant-level metrics
 */
export interface TenantMetrics {
  requests: number;
  errors: number;
  latency: {
    average: number;
  };
}

/**
 * System event from /events/registry SSE stream
 */
export type SystemEvent = RegistryEvent | HealthEvent;

/**
 * Registry snapshot event
 */
export interface RegistryEvent {
  type: 'registry';
  rev: string;
  generatedAt: string;
  partial: boolean;
  stale: boolean;
  expiresAt: string | null;
  ttlMs: number | null;
  checksum?: string;
  checksumAlgorithm?: 'sha256';
  previousChecksum: string | null;
}

/**
 * Health status event
 */
export interface HealthEvent {
  type: 'health';
  status: 'healthy' | 'unhealthy';
  ts: string;
  ready: boolean;
  reason: string | null;
  registryPartial: boolean;
  registryStale: boolean;
  registryLoaded: boolean;
  pluginMountInProgress: boolean;
  pluginRoutesMounted: boolean;
  pluginsMounted: number;
  pluginsFailed: number;
  lastPluginMountTs: string | null;
  pluginRoutesLastDurationMs: number | null;
  redisEnabled: boolean;
  redisHealthy: boolean;
  redisStates?: Array<{ role: string; state: string }>;
}

/**
 * Log record (matches backend LogRecord interface)
 */
export interface LogRecord {
  id?: string; // ULID log identifier (present in database, may be missing in live stream)
  time: string; // ISO 8601 timestamp
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error';
  msg?: string;
  plugin?: string;
  runId?: string;
  command?: string;
  executionId?: string;
  tenantId?: string;
  trace?: string; // OpenTelemetry trace ID
  span?: string; // OpenTelemetry span ID
  err?: {
    name: string;
    message: string;
    stack?: string;
    code?: string;
  };
  meta?: Record<string, unknown>;
  [key: string]: unknown; // Additional fields from Pino
}

/**
 * Log query filters
 */
export interface LogQuery {
  from?: string; // ISO timestamp
  to?: string; // ISO timestamp
  level?: string; // trace|debug|info|warn|error (comma-separated)
  plugin?: string;
  runId?: string;
  executionId?: string;
  tenantId?: string;
  search?: string; // Text search in msg field
  limit?: number; // Max records (default 100, max 1000)
  offset?: number; // Pagination offset
}

/**
 * Log query response
 */
export interface LogQueryResponse {
  ok: boolean;
  data: {
    logs: LogRecord[];
    total: number;
    filters: LogQuery;
    bufferStats: {
      size: number;
      maxSize: number;
      oldest?: string;
      newest?: string;
    };
  };
}

/**
 * Log event from /logs/stream SSE
 */
export interface LogEvent {
  type: 'log';
  time: string;
  level: LogRecord['level'];
  msg?: string;
  plugin?: string;
  runId?: string;
  executionId?: string;
  tenantId?: string;
  [key: string]: unknown;
}

/**
 * Context options for AI summarization
 */
export interface LogSummarizeContext {
  errors?: boolean;
  warnings?: boolean;
  info?: boolean;
  metadata?: boolean;
  stackTraces?: boolean;
}

/**
 * Log summarization request
 */
export interface LogSummarizeRequest {
  /** User's question about the logs */
  question: string;
  /** Context inclusion options */
  includeContext?: LogSummarizeContext;
  /** Time range filter */
  timeRange?: { from?: string; to?: string };
  /** Log filters */
  filters?: {
    level?: string;
    plugin?: string;
    runId?: string;
    traceId?: string;
    executionId?: string;
  };
  /** Group logs by field */
  groupBy?: 'trace' | 'execution' | 'plugin';
}

/**
 * Log statistics for AI context
 */
export interface LogStats {
  total: number;
  byLevel: Record<string, number>;
  byPlugin: Record<string, number>;
  topErrors: Array<{ message: string; count: number }>;
  timeRange: {
    from: string | null;
    to: string | null;
  };
}

/**
 * Log summarization response
 */
export interface LogSummarizeResponse {
  summary: {
    question: string;
    timeRange: {
      from: string | null;
      to: string | null;
    };
    total: number;
    stats: LogStats;
    groups: Record<string, any[]> | null;
  };
  /** AI-generated summary (null if LLM unavailable) */
  aiSummary: string | null;
  /** Info message if AI not available */
  message?: string | null;
}

/**
 * Historical data point for time-series metrics
 */
export interface HistoricalDataPoint {
  /** Unix timestamp in milliseconds */
  timestamp: number;
  /** Metric value */
  value: number;
}

/**
 * Heatmap cell data (7 days × 24 hours)
 */
export interface HeatmapCell {
  /** Day of week: 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun' */
  day: string;
  /** Hour of day: 0-23 */
  hour: number;
  /** Aggregated metric value */
  value: number;
}

/**
 * Metrics history query options
 */
export interface MetricsHistoryQuery {
  /** Metric type */
  metric: 'requests' | 'errors' | 'latency' | 'uptime';
  /** Time range */
  range: '1m' | '5m' | '10m' | '30m' | '1h';
  /** Aggregation interval (optional) */
  interval?: '5s' | '1m' | '5m';
}

/**
 * Metrics heatmap query options
 */
export interface MetricsHeatmapQuery {
  /** Metric type */
  metric: 'latency' | 'errors' | 'requests';
  /** Number of days (optional, default: 7) */
  days?: 7 | 14 | 30;
}

/**
 * Incident severity levels
 */
export type IncidentSeverity = 'critical' | 'warning' | 'info';

/**
 * Incident type categories
 */
export type IncidentType =
  | 'error_rate'
  | 'latency_spike'
  | 'plugin_failure'
  | 'adapter_failure'
  | 'system_health'
  | 'custom';

/**
 * Root cause analysis item
 */
export interface RootCauseItem {
  /** Factor contributing to the incident */
  factor: string;
  /** Confidence level (0.0 - 1.0) */
  confidence: number;
  /** Evidence supporting this root cause */
  evidence: string;
}

/**
 * Related logs data collected during incident
 */
export interface RelatedLogsData {
  errorCount: number;
  warnCount: number;
  timeRange: [number, number];
  sampleErrors: string[];
  topEndpoints?: Array<{
    endpoint: string;
    count: number;
    sample: string;
  }>;
}

/**
 * Slow request details
 */
export interface SlowRequest {
  endpoint: string;
  method: string;
  durationMs: number;
  statusCode?: number;
}

/**
 * Related metrics data (before/during comparison)
 */
export interface RelatedMetricsData {
  before?: Record<string, number>;
  during?: Record<string, number>;
  topSlowest?: SlowRequest[];
  affectedEndpoints?: string[];
}

/**
 * Timeline event during incident
 */
export interface TimelineEvent {
  timestamp: number;
  event: string;
  source: 'detector' | 'logs' | 'metrics' | 'manual';
}

/**
 * Related data gathered during incident detection
 */
export interface RelatedData {
  logs?: RelatedLogsData;
  metrics?: RelatedMetricsData;
  timeline?: TimelineEvent[];
}

/**
 * AI-generated incident analysis
 */
export interface IncidentAnalysis {
  summary: string;
  rootCauses: RootCauseItem[];
  patterns: string[];
  recommendations: string[];
  analyzedAt: number;
}

/**
 * Incident record
 */
export interface Incident {
  /** Unique incident identifier */
  id: string;
  /** Incident type */
  type: IncidentType;
  /** Severity level */
  severity: IncidentSeverity;
  /** Incident title/summary */
  title: string;
  /** Detailed description */
  details: string;
  /** Root cause analysis (optional) - array of contributing factors */
  rootCause?: RootCauseItem[];
  /** Affected services/plugins */
  affectedServices?: string[];
  /** Timestamp when incident occurred (Unix ms) */
  timestamp: number;
  /** Timestamp when incident was resolved (Unix ms) */
  resolvedAt?: number;
  /** Resolution notes */
  resolutionNotes?: string;
  /** Related metrics/logs */
  metadata?: Record<string, unknown>;
  /** Related data gathered during detection (NEW) */
  relatedData?: RelatedData;
  /** AI analysis results (NEW) */
  aiAnalysis?: IncidentAnalysis;
  /** When AI analysis was performed (NEW) */
  aiAnalyzedAt?: number;
}

/**
 * Incident query options
 */
export interface IncidentQuery {
  /** Maximum number of incidents to return (default: 50) */
  limit?: number;
  /** Filter by severity */
  severity?: IncidentSeverity | IncidentSeverity[];
  /** Filter by type */
  type?: IncidentType | IncidentType[];
  /** Filter by time range (from timestamp) */
  from?: number;
  /** Filter by time range (to timestamp) */
  to?: number;
  /** Include resolved incidents (default: false) */
  includeResolved?: boolean;
}

/**
 * Incident create payload
 */
export interface IncidentCreatePayload {
  type: IncidentType;
  severity: IncidentSeverity;
  title: string;
  details: string;
  rootCause?: RootCauseItem[];
  affectedServices?: string[];
  timestamp?: number;
  metadata?: Record<string, unknown>;
  relatedData?: RelatedData;
}

/**
 * Incidents list response with summary stats
 */
export interface IncidentsListResponse {
  ok: boolean;
  data: {
    incidents: Incident[];
    summary: {
      total: number;
      unresolved: number;
      bySeverity: {
        critical: number;
        warning: number;
        info: number;
      };
      showing: number;
    };
  };
}

/**
 * Incident detail response
 */
export interface IncidentDetailResponse {
  ok: boolean;
  data: Incident;
}

/**
 * Incident analysis response
 */
export interface IncidentAnalysisResponse {
  ok: boolean;
  data: IncidentAnalysis & {
    cached: boolean;
  };
}

/**
 * Incident resolve request
 */
export interface IncidentResolveRequest {
  resolutionNotes?: string;
}
