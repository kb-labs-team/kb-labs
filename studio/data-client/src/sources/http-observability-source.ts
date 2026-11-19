/**
 * @module @kb-labs/studio-data-client/sources/http-observability-source
 * HTTP implementation of ObservabilityDataSource
 */

import type { AxiosRequestConfig } from 'axios';
import type { HttpClient } from '../client/http-client';
import { projectServicePath } from '@kb-labs/plugin-contracts/project-service-path';
import { KBError } from '../errors/kb-error';
import type { ObservabilityDataSource } from './observability-source';
import type {
  StateBrokerStats,
  DevKitHealth,
  PrometheusMetrics,
  SystemEvent,
  LogQuery,
  LogQueryResponse,
  LogRecord,
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
import { parsePrometheusMetrics } from './prometheus-metrics-parser';

/**
 * HTTP implementation of ObservabilityDataSource
 */
export class HttpObservabilitySource implements ObservabilityDataSource {
  constructor(private client: HttpClient, private readonly projectId?: string) {}

  private path(path: string): string {
    if (!this.projectId) {throw new Error('Select a project to view project observability.');}
    return projectServicePath(this.projectId, 'rest', path);
  }

  private fetch<T>(path: string, options: AxiosRequestConfig = {}): Promise<T> {
    return this.client.fetch<T>(path, { ...options, baseURL: '' });
  }

  async getStateBrokerStats(): Promise<StateBrokerStats> {
    try {
      return await this.fetch<StateBrokerStats>(
        this.path('/observability/state-broker')
      );
    } catch (error) {
      throw new KBError(
        'STATE_BROKER_FETCH_FAILED',
        'Failed to fetch State Broker stats',
        500,
        error
      );
    }
  }

  async getDevKitHealth(): Promise<DevKitHealth> {
    try {
      return await this.fetch<DevKitHealth>(
        this.path('/observability/devkit')
      );
    } catch (error) {
      throw new KBError(
        'DEVKIT_FETCH_FAILED',
        'Failed to fetch DevKit health',
        500,
        error
      );
    }
  }

  async getPrometheusMetrics(): Promise<PrometheusMetrics> {
    try {
      const payload = await this.fetch<string>(
        this.path('/metrics'),
        { responseType: 'text' }
      );

      return parsePrometheusMetrics(payload);
    } catch (error) {
      throw new KBError(
        'PROMETHEUS_METRICS_FETCH_FAILED',
        'Failed to fetch Prometheus metrics',
        500,
        error
      );
    }
  }

  subscribeToSystemEvents(
    onEvent: (event: SystemEvent) => void,
    onError: (error: Error) => void
  ): () => void {
    if (!this.projectId) {
      onError(new Error('Select a project to view project events.'));
      return () => {};
    }
    const baseUrl = this.client.getGatewayBaseUrl();
    const eventSource = new EventSource(`${baseUrl}${this.path('/events/registry')}`);

    eventSource.addEventListener('registry', (e) => {
      try {
        const event = JSON.parse(e.data) as SystemEvent;
        onEvent(event);
      } catch (err) {
        console.error('Failed to parse registry event:', err);
      }
    });

    eventSource.addEventListener('health', (e) => {
      try {
        const event = JSON.parse(e.data) as SystemEvent;
        onEvent(event);
      } catch (err) {
        console.error('Failed to parse health event:', err);
      }
    });

    eventSource.onerror = () => {
      onError(new Error('Connection to event stream failed'));
      eventSource.close();
    };

    // Return cleanup function
    return () => {
      eventSource.close();
    };
  }

  async queryLogs(filters: LogQuery): Promise<LogQueryResponse> {
    try {
      const params = new URLSearchParams();

      if (filters.from) {params.append('from', filters.from);}
      if (filters.to) {params.append('to', filters.to);}
      if (filters.level) {params.append('level', filters.level);}
      if (filters.plugin) {params.append('plugin', filters.plugin);}
      if (filters.executionId) {params.append('executionId', filters.executionId);}
      if (filters.traceId) {params.append('traceId', filters.traceId);}
      if (filters.tenantId) {params.append('tenantId', filters.tenantId);}
      if (filters.search) {params.append('search', filters.search);}
      if (filters.limit !== undefined) {params.append('limit', String(filters.limit));}
      if (filters.offset !== undefined) {params.append('offset', String(filters.offset));}

      const queryString = params.toString();
      const url = this.path(queryString ? `/logs?${queryString}` : '/logs');

      return await this.fetch<LogQueryResponse>(url);
    } catch (error) {
      throw new KBError(
        'LOGS_QUERY_FAILED',
        'Failed to query logs',
        500,
        error
      );
    }
  }

  subscribeToLogs(
    onLog: (log: LogRecord) => void,
    onError: (error: Error) => void,
    filters?: LogQuery
  ): () => void {
    if (!this.projectId) {
      onError(new Error('Select a project to view project logs.'));
      return () => {};
    }
    // Build query string from filters
    const params = new URLSearchParams();
    if (filters?.level) {params.append('level', filters.level);}
    if (filters?.plugin) {params.append('plugin', filters.plugin);}
    if (filters?.executionId) {params.append('executionId', filters.executionId);}
    if (filters?.traceId) {params.append('traceId', filters.traceId);}
    if (filters?.tenantId) {params.append('tenantId', filters.tenantId);}

    const queryString = params.toString();
    const baseUrl = this.client.getGatewayBaseUrl();
    const streamBase = `${baseUrl}${this.path('')}`;
    const url = queryString
      ? `${streamBase}/logs/stream?${queryString}`
      : `${streamBase}/logs/stream`;

    const eventSource = new EventSource(url);

    eventSource.addEventListener('log', (e) => {
      try {
        const log = JSON.parse(e.data) as LogRecord;
        onLog(log);
      } catch (err) {
        console.error('Failed to parse log event:', err);
      }
    });

    eventSource.onerror = () => {
      onError(new Error('Connection to log stream failed'));
      eventSource.close();
    };

    // Return cleanup function
    return () => {
      eventSource.close();
    };
  }

  async summarizeLogs(request: LogSummarizeRequest): Promise<LogSummarizeResponse> {
    try {
      return await this.fetch<LogSummarizeResponse>(this.path('/logs/summarize'), {
        method: 'POST',
        data: request,
      });
    } catch (error) {
      throw new KBError(
        'LOG_SUMMARIZATION_FAILED',
        'Failed to summarize logs',
        500,
        error
      );
    }
  }

  async getLog(id: string, includeRelated?: boolean): Promise<{ log: LogRecord; related?: LogRecord[] }> {
    try {
      const params = new URLSearchParams();
      if (includeRelated) {
        params.append('includeRelated', 'true');
      }

      const queryString = params.toString();
      const url = this.path(queryString ? `/logs/${id}?${queryString}` : `/logs/${id}`);

      return await this.fetch<{ log: LogRecord; related?: LogRecord[] }>(url);
    } catch (error) {
      throw new KBError(
        'LOG_FETCH_FAILED',
        'Failed to fetch log',
        500,
        error
      );
    }
  }

  async getRelatedLogs(id: string): Promise<{ total: number; logs: LogRecord[]; correlationKeys: Record<string, unknown> }> {
    try {
      return await this.fetch<{ total: number; logs: LogRecord[]; correlationKeys: Record<string, unknown> }>(
        this.path(`/logs/${id}/related`)
      );
    } catch (error) {
      throw new KBError(
        'RELATED_LOGS_FETCH_FAILED',
        'Failed to fetch related logs',
        500,
        error
      );
    }
  }

  async getMetricsHistory(query: MetricsHistoryQuery): Promise<HistoricalDataPoint[]> {
    try {
      const params = new URLSearchParams();
      params.append('metric', query.metric);
      params.append('range', query.range);
      if (query.interval) {params.append('interval', query.interval);}

      // HttpClient auto-unwraps { ok, data } envelope in response interceptor
      return await this.fetch<HistoricalDataPoint[]>(
        this.path(`/observability/metrics/history?${params.toString()}`)
      );
    } catch (error) {
      throw new KBError(
        'METRICS_HISTORY_FETCH_FAILED',
        'Failed to fetch metrics history',
        500,
        error
      );
    }
  }

  async getMetricsHeatmap(query: MetricsHeatmapQuery): Promise<HeatmapCell[]> {
    try {
      const params = new URLSearchParams();
      params.append('metric', query.metric);
      if (query.days) {params.append('days', String(query.days));}

      // HttpClient auto-unwraps { ok, data } envelope in response interceptor
      return await this.fetch<HeatmapCell[]>(
        this.path(`/observability/metrics/heatmap?${params.toString()}`)
      );
    } catch (error) {
      throw new KBError(
        'METRICS_HEATMAP_FETCH_FAILED',
        'Failed to fetch metrics heatmap',
        500,
        error
      );
    }
  }

  async queryIncidents(query?: IncidentQuery): Promise<Incident[]> {
    try {
      const params = new URLSearchParams();
      if (query?.limit) {params.append('limit', String(query.limit));}
      if (query?.severity) {
        const severityList = Array.isArray(query.severity) ? query.severity : [query.severity];
        params.append('severity', severityList.join(','));
      }
      if (query?.type) {
        const typeList = Array.isArray(query.type) ? query.type : [query.type];
        params.append('type', typeList.join(','));
      }
      if (query?.from) {params.append('from', String(query.from));}
      if (query?.to) {params.append('to', String(query.to));}
      if (query?.includeResolved !== undefined) {
        params.append('includeResolved', String(query.includeResolved));
      }

      const queryString = params.toString();
      const url = this.path(queryString ? `/observability/incidents/history?${queryString}` : '/observability/incidents/history');

      // HttpClient auto-unwraps { ok, data } envelope in response interceptor
      return await this.fetch<Incident[]>(url);
    } catch (error) {
      throw new KBError(
        'INCIDENTS_QUERY_FAILED',
        'Failed to query incidents',
        500,
        error
      );
    }
  }

  async createIncident(payload: IncidentCreatePayload): Promise<Incident> {
    try {
      // HttpClient auto-unwraps { ok, data } envelope in response interceptor
      return await this.fetch<Incident>(
        this.path('/observability/incidents'),
        {
          method: 'POST',
          data: payload,
        }
      );
    } catch (error) {
      throw new KBError(
        'INCIDENT_CREATE_FAILED',
        'Failed to create incident',
        500,
        error
      );
    }
  }

  async resolveIncident(id: string, resolutionNotes?: string): Promise<Incident> {
    try {
      // HttpClient auto-unwraps { ok, data } envelope in response interceptor
      return await this.fetch<Incident>(
        this.path(`/observability/incidents/${id}/resolve`),
        {
          method: 'POST',
          data: { resolutionNotes },
        }
      );
    } catch (error) {
      throw new KBError(
        'INCIDENT_RESOLVE_FAILED',
        'Failed to resolve incident',
        500,
        error
      );
    }
  }

  async listIncidents(query?: IncidentQuery): Promise<IncidentsListResponse> {
    try {
      const params = buildIncidentQueryParams(query);
      const url = this.path(`/observability/incidents${params ? `?${params}` : ''}`);
      const response = await this.fetch<IncidentsListResponse['data']>(url);

      return {
        ok: true,
        data: response,
      };
    } catch (error) {
      throw new KBError(
        'INCIDENTS_LIST_FAILED',
        'Failed to list incidents',
        500,
        error
      );
    }
  }

  async getIncident(id: string): Promise<IncidentDetailResponse> {
    try {
      const data = await this.fetch<Incident>(this.path(`/observability/incidents/${id}`));

      return {
        ok: true,
        data,
      };
    } catch (error) {
      throw new KBError(
        'INCIDENT_FETCH_FAILED',
        'Failed to fetch incident',
        500,
        error
      );
    }
  }

  async analyzeIncident(id: string): Promise<IncidentAnalysisResponse> {
    try {
      const data = await this.fetch<IncidentAnalysisResponse['data']>(
        this.path(`/observability/incidents/${id}/analyze`),
        { method: 'POST' }
      );

      return {
        ok: true,
        data,
      };
    } catch (error) {
      throw new KBError(
        'INCIDENT_ANALYSIS_FAILED',
        'Failed to analyze incident',
        500,
        error
      );
    }
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
    try {
      return await this.fetch<{
        answer: string;
        context: string[];
        usage: {
          promptTokens: number;
          completionTokens: number;
          totalTokens: number;
        };
      }>(this.path('/observability/insights/chat'), {
        method: 'POST',
        data: { question, context },
      });
    } catch (error) {
      throw new KBError(
        'INSIGHTS_CHAT_FAILED',
        'Failed to chat with AI insights',
        500,
        error
      );
    }
  }
}

function buildIncidentQueryParams(query?: IncidentQuery): string {
  if (!query) { return ''; }
  const params = new URLSearchParams();
  if (query.limit !== undefined) { params.append('limit', query.limit.toString()); }
  if (query.severity) {
    const severities = Array.isArray(query.severity) ? query.severity : [query.severity];
    severities.forEach(s => params.append('severity', s));
  }
  if (query.type) {
    const types = Array.isArray(query.type) ? query.type : [query.type];
    types.forEach(t => params.append('type', t));
  }
  if (query.from !== undefined) { params.append('from', query.from.toString()); }
  if (query.to !== undefined) { params.append('to', query.to.toString()); }
  if (query.includeResolved !== undefined) { params.append('includeResolved', query.includeResolved.toString()); }
  return params.toString();
}
