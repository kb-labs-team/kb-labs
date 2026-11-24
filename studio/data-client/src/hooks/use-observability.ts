/**
 * @module @kb-labs/studio-data-client/hooks/use-observability
 * React Query hooks for observability data
 */

import { useQuery } from '@tanstack/react-query';
import { useState, useEffect } from 'react';
import type { ObservabilityDataSource } from '../sources/observability-source';
import type {
  SystemEvent,
  LogRecord,
  LogQuery,
  MetricsHistoryQuery,
  MetricsHeatmapQuery,
  IncidentQuery,
} from '../contracts/observability';

/**
 * Hook to fetch State Broker statistics
 *
 * Auto-refreshes every 5 seconds to show real-time cache metrics
 */
export function useStateBrokerStats(source: ObservabilityDataSource) {
  return useQuery({
    queryKey: ['observability', 'state-broker'],
    queryFn: () => source.getStateBrokerStats(),
    refetchInterval: 5000, // Auto-refresh every 5s for real-time updates
    staleTime: 3000, // Consider data stale after 3s
    retry: 2, // Retry failed requests twice
  });
}

/**
 * Hook to fetch DevKit health snapshot
 *
 * Caches for 1 minute as DevKit health doesn't change frequently
 */
export function useDevKitHealth(source: ObservabilityDataSource) {
  return useQuery({
    queryKey: ['observability', 'devkit'],
    queryFn: () => source.getDevKitHealth(),
    staleTime: 60000, // Cache for 1 minute
    gcTime: 300000, // Keep in cache for 5 minutes (React Query v5)
    retry: 1, // DevKit can be slow, only retry once
  });
}

/**
 * Hook to fetch Prometheus metrics from REST API
 *
 * Auto-refreshes every 10 seconds to show near real-time metrics
 */
export function usePrometheusMetrics(source: ObservabilityDataSource) {
  return useQuery({
    queryKey: ['observability', 'prometheus-metrics'],
    queryFn: () => source.getPrometheusMetrics(),
    refetchInterval: 10000, // Auto-refresh every 10s
    staleTime: 8000, // Consider data stale after 8s
    retry: 2, // Retry failed requests twice
  });
}

/**
 * Hook to connect to system events SSE stream
 *
 * Uses ObservabilityDataSource to subscribe to real-time system events
 */
export function useSystemEvents(source: ObservabilityDataSource) {
  const [events, setEvents] = useState<SystemEvent[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    setIsConnected(true);
    setError(null);

    const cleanup = source.subscribeToSystemEvents(
      (event) => {
        setEvents((prev) => [event, ...prev].slice(0, 100)); // Keep last 100 events
      },
      (err) => {
        setIsConnected(false);
        setError(err);
      }
    );

    return () => {
      cleanup();
      setIsConnected(false);
    };
  }, [source]);

  return { events, isConnected, error };
}

/**
 * Hook to connect to live log stream
 *
 * Uses ObservabilityDataSource to subscribe to real-time logs
 *
 * @param source - Observability data source
 * @param filters - Optional log filters
 */
export function useLogStream(source: ObservabilityDataSource, filters?: LogQuery, enabled = true) {
  const [logs, setLogs] = useState<LogRecord[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!enabled) {return;}
    setIsConnected(true);
    setError(null);

    const cleanup = source.subscribeToLogs(
      (log) => {
        // Add log to beginning (most recent first)
        // Keep max 500 logs in memory for performance
        setLogs((prev) => [log, ...prev].slice(0, 500));
      },
      (err) => {
        setIsConnected(false);
        setError(err);
      },
      filters
    );

    return () => {
      cleanup();
      setIsConnected(false);
    };
  }, [source, filters, enabled]);

  const clearLogs = () => setLogs([]);

  return { logs, isConnected, error, clearLogs };
}

/**
 * Hook to fetch historical metrics time-series data
 *
 * Auto-refreshes every 5 seconds for near real-time charts
 */
export function useMetricsHistory(source: ObservabilityDataSource, query: MetricsHistoryQuery) {
  return useQuery({
    queryKey: ['observability', 'metrics-history', query.metric, query.range, query.interval],
    queryFn: () => source.getMetricsHistory(query),
    refetchInterval: 5000, // Auto-refresh every 5s
    staleTime: 3000, // Consider data stale after 3s
    retry: 2,
  });
}

/**
 * Hook to fetch metrics heatmap data
 *
 * Caches for 1 minute as heatmap data changes slowly
 */
export function useMetricsHeatmap(source: ObservabilityDataSource, query: MetricsHeatmapQuery) {
  return useQuery({
    queryKey: ['observability', 'metrics-heatmap', query.metric, query.days],
    queryFn: () => source.getMetricsHeatmap(query),
    staleTime: 60000, // Cache for 1 minute
    gcTime: 300000, // Keep in cache for 5 minutes
    retry: 2,
  });
}

/**
 * Hook to query incident history
 *
 * Auto-refreshes every 30 seconds to show new incidents
 */
export function useIncidents(source: ObservabilityDataSource, query?: IncidentQuery) {
  return useQuery({
    queryKey: ['observability', 'incidents', query],
    queryFn: () => source.queryIncidents(query),
    refetchInterval: 30000, // Auto-refresh every 30s
    staleTime: 20000, // Consider data stale after 20s
    retry: 2,
  });
}
