import * as React from 'react';
import {
  UICard,
  UIAlert,
  UIBadge,
  UITag,
  UIList,
  UIListItem,
  UITypographyText,
  UITypographyParagraph,
  UISpace,
  UIRow,
  UICol,
  UISelect,
  UIButton,
  UIAccordion,
  UIDescriptions,
  UIDescriptionsItem,
  UIMessage,
  UIModal,
  UIInput,
  UISegmented,
  UIInputTextArea,
  UIDivider,
  UISpin,
  UIIcon,
} from '@kb-labs/studio-ui-kit';
import { UIRangePicker, UICheckbox } from '@kb-labs/studio-ui-kit';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState, useMemo, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useLogStream } from '@kb-labs/studio-data-client';
import { useDataSources } from '../../../providers/data-sources-provider';
import { useProjectContext } from '../../../providers/project-context-provider';
import type { LogRecord, LogSummarizeResponse } from '@kb-labs/studio-data-client';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';
import { UIPage, UIPageHeader } from '@kb-labs/studio-ui-kit';
import { AnalyticsSummaryStrip } from '../../analytics/components/analytics-summary-strip';
import { resolveLogTimeRange, TIME_RANGES } from '../log-time-range';

const LEVEL_COLORS: Record<string, string> = {
  error: 'var(--error)',
  warn: 'var(--warning)',
  info: 'var(--info)',
  debug: 'var(--text-tertiary)',
  trace: 'var(--text-tertiary)',
};


/**
 * Time range presets for quick filtering
 */
/**
 * Quick question templates for AI summarization
 */
const QUESTION_TEMPLATES = [
  { label: 'What happened?', value: 'What happened in these logs?' },
  { label: 'Show errors', value: 'What errors occurred and what caused them?' },
  { label: 'Find patterns', value: 'Are there any patterns or repeated issues?' },
  { label: 'Performance issues', value: 'Are there any performance or latency issues?' },
  { label: 'Timeline', value: 'Give me a timeline of key events' },
  { label: 'Root cause', value: 'What is the root cause of the errors?' },
];

/**
 * Format timestamp to time string
 */
function formatTime(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString();
}

/**
 * Group logs by a field
 */
function groupLogsByField(logs: LogRecord[], field: keyof LogRecord): Map<string, LogRecord[]> {
  const groups = new Map<string, LogRecord[]>();
  for (const log of logs) {
    const key = String(log[field] || 'unknown');
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)!.push(log);
  }
  return groups;
}

/**
 * Calculate log statistics for AI summarization
 */
function calculateLogStats(logs: LogRecord[]) {
  const stats = {
    total: logs.length,
    byLevel: {} as Record<string, number>,
    byPlugin: {} as Record<string, number>,
    errorCount: 0,
    warningCount: 0,
    uniqueTraces: new Set<string>(),
    uniqueExecutions: new Set<string>(),
    timeRange: {
      oldest: logs.length > 0 ? logs[0]!.time : null,
      newest: logs.length > 0 ? logs[logs.length - 1]!.time : null,
    },
  };

  for (const log of logs) {
    // Count by level
    stats.byLevel[log.level] = (stats.byLevel[log.level] || 0) + 1;

    // Count by plugin
    if (log.plugin) {
      stats.byPlugin[log.plugin] = (stats.byPlugin[log.plugin] || 0) + 1;
    }

    // Track errors and warnings
    if (log.level === 'error') {stats.errorCount++;}
    if (log.level === 'warn') {stats.warningCount++;}

    // Track unique traces and executions
    if (log.trace) {stats.uniqueTraces.add(log.trace);}
    if (log.executionId) {stats.uniqueExecutions.add(log.executionId);}
  }

  return stats;
}

/**
 * Compact, single-line log row — click to expand raw JSON.
 * Replaces the old UIAccordion-per-row rendering (huge padding, generic chevron).
 */
function LogRow({ log }: { log: LogRecord }) {
  const [expanded, setExpanded] = useState(false);
  const levelColor = LEVEL_COLORS[log.level] ?? 'var(--text-tertiary)';

  const jsonString = useMemo(() => {
    try {
      return JSON.stringify(log, null, 2);
    } catch {
      return JSON.stringify(
        {
          ...log,
          err: log.err
            ? {
                name: String(log.err.name || 'Error'),
                message: String(log.err.message || ''),
                stack: String(log.err.stack || '').split('\n').slice(0, 10).join('\n'),
              }
            : undefined,
        },
        null,
        2
      );
    }
  }, [log]);

  return (
    <div style={{ borderBottom: '1px solid var(--border-primary)' }}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          padding: '6px 10px',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
          fontFamily: 'ui-monospace, monospace',
          fontSize: 12,
        }}
      >
        {expanded ? (
          <ChevronDown size={12} style={{ flexShrink: 0, color: 'var(--text-tertiary)' }} />
        ) : (
          <ChevronRight size={12} style={{ flexShrink: 0, color: 'var(--text-tertiary)' }} />
        )}
        <span style={{ width: 3, height: 14, borderRadius: 2, background: levelColor, flexShrink: 0 }} />
        <span style={{ color: 'var(--text-tertiary)', flexShrink: 0 }}>{formatTime(log.time)}</span>
        <span style={{ color: levelColor, fontWeight: 600, flexShrink: 0, minWidth: 44 }}>
          {log.level.toUpperCase()}
        </span>
        {log.plugin && <span style={{ color: 'var(--info)', flexShrink: 0 }}>[{log.plugin}]</span>}
        <span
          style={{
            color: 'var(--text-primary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: 1,
          }}
        >
          {String(log.msg || '(no message)')}
          {log.err ? ` (${String(log.err.name || 'Error')})` : ''}
        </span>
      </button>
      {expanded && (
        <div style={{ background: 'var(--bg-tertiary)', padding: 12 }}>
          <UITypographyParagraph
            copyable={{ text: jsonString }}
            style={{
              marginBottom: 0,
              fontSize: 12,
              fontFamily: 'ui-monospace, monospace',
              whiteSpace: 'pre-wrap',
              maxHeight: 400,
              overflow: 'auto',
            }}
          >
            {jsonString}
          </UITypographyParagraph>
        </div>
      )}
    </div>
  );
}

/**
 * Live Logs Page with AI Summarization support
 *
 * Features:
 * - Real-time log streaming via SSE
 * - Advanced filtering (time, level, plugin, trace)
 * - Log grouping (by trace, execution, plugin)
 * - Expandable log details
 * - Copy traceId/executionId
 * - Statistics for AI summarization
 */
export function LogsPage() {
  const [searchParams] = useSearchParams();
  const { projectId: selectedProjectId, setProjectId } = useProjectContext();
  const requestedProjectId = searchParams.get('projectId');
  const requestedProjectSelected = !requestedProjectId || selectedProjectId === requestedProjectId;
  const requestedRunId = searchParams.get('runId');
  const requestedExecutionId = searchParams.get('executionId');
  const [runIdFilter, setRunIdFilter] = useState<string | null>(requestedRunId);
  const [executionIdFilter, setExecutionIdFilter] = useState<string | null>(requestedExecutionId);
  const sources = useDataSources();
  const streamFilters = useMemo(
    () => runIdFilter || executionIdFilter
      ? { runId: runIdFilter ?? undefined, executionId: executionIdFilter ?? undefined }
      : undefined,
    [runIdFilter, executionIdFilter],
  );
  const { logs: streamLogs, isConnected, error, clearLogs } = useLogStream(
    sources.observability,
    streamFilters,
    requestedProjectSelected,
  );
  const [viewMode, setViewMode] = useState<'live' | 'history'>(
    searchParams.get('mode') === 'history' ? 'history' : 'live',
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [historyRefreshToken, setHistoryRefreshToken] = useState(0);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyPageSize, setHistoryPageSize] = useState(50);
  const [historyLogs, setHistoryLogs] = useState<LogRecord[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<Error | null>(null);
  const [historySource, setHistorySource] = useState<string | undefined>(undefined);
  const [historyStats, setHistoryStats] = useState<any>(null);

  // Pause/Resume state
  const [isPaused, setIsPaused] = useState(false);
  const [frozenLogs, setFrozenLogs] = useState<LogRecord[]>([]);

  // Update frozen logs when not paused
  useEffect(() => {
    if (!isPaused) {
      setFrozenLogs(streamLogs);
    }
  }, [streamLogs, isPaused]);

  // Filters
  const [levelFilter, setLevelFilter] = useState<string | null>(null);
  const [pluginFilter, setPluginFilter] = useState<string | null>(null);
  const [timeRange, setTimeRange] = useState<string>(requestedRunId ? 'all' : '15m');
  const [customTimeRange, setCustomTimeRange] = useState<[Dayjs, Dayjs] | null>(null);
  const [groupBy, setGroupBy] = useState<'none' | 'trace' | 'execution' | 'plugin'>('none');

  useEffect(() => {
    if (requestedProjectId) {setProjectId(requestedProjectId);}
    setRunIdFilter(requestedRunId);
    setExecutionIdFilter(requestedExecutionId);
  }, [requestedProjectId, requestedRunId, requestedExecutionId, setProjectId]);

  // AI Summarize Modal
  const [summarizeModalOpen, setSummarizeModalOpen] = useState(false);
  const [customQuestion, setCustomQuestion] = useState('');
  const [includeContext, setIncludeContext] = useState({
    errors: true,
    warnings: true,
    info: false,
    metadata: true,
    stackTraces: true,
  });
  const [summarizing, setSummarizing] = useState(false);
  const [summaryResult, setSummaryResult] = useState<LogSummarizeResponse['data'] | null>(null);

  useEffect(() => {
    if (viewMode !== 'history' || !requestedProjectSelected) {return;}
    setHistoryPage(1);
  }, [viewMode, levelFilter, pluginFilter, timeRange, customTimeRange, searchQuery, requestedProjectSelected]);

  // Query logs history from backend with server-side filtering/pagination/search
  useEffect(() => {
    if (viewMode !== 'history' || !requestedProjectSelected) {return;}

    let cancelled = false;

    const fetchHistory = async () => {
      setHistoryLoading(true);
      setHistoryError(null);

      try {
        const query: any = {
          limit: historyPageSize,
          offset: (historyPage - 1) * historyPageSize,
        };

        if (levelFilter) {
          query.level = levelFilter;
        }
        if (pluginFilter) {
          query.plugin = pluginFilter;
        }
        if (executionIdFilter) {
          query.executionId = executionIdFilter;
        }
        if (runIdFilter) {
          query.runId = runIdFilter;
        }
        if (searchQuery.trim()) {
          query.search = searchQuery.trim();
        }

        const selectedTimeRange = resolveLogTimeRange(timeRange, customTimeRange);
        if (selectedTimeRange) {
          query.from = selectedTimeRange.from;
          query.to = selectedTimeRange.to;
        }

        const result: any = await sources.observability.queryLogs(query);
        const data = result?.logs ? result : result?.data ?? {};

        if (cancelled) {return;}

        const logs = Array.isArray(data.logs) ? data.logs : [];
        setHistoryLogs(logs);
        setHistoryTotal(typeof data.total === 'number' ? data.total : logs.length);
        setHistorySource(typeof data.source === 'string' ? data.source : undefined);
        setHistoryStats(data.stats ?? null);
      } catch (err: any) {
        if (cancelled) {return;}
        setHistoryError(err instanceof Error ? err : new Error(String(err)));
        setHistoryLogs([]);
        setHistoryTotal(0);
      } finally {
        if (!cancelled) {
          setHistoryLoading(false);
        }
      }
    };

    void fetchHistory();

    return () => {
      cancelled = true;
    };
  }, [
    viewMode,
    historyPage,
    historyPageSize,
    levelFilter,
    pluginFilter,
    executionIdFilter,
    runIdFilter,
    timeRange,
    customTimeRange,
    searchQuery,
    historyRefreshToken,
    sources.observability,
    requestedProjectSelected,
  ]);

  // Calculate filtered logs
  const logs = viewMode === 'history' ? historyLogs : (isPaused ? frozenLogs : streamLogs);

  const filteredLogs = useMemo(() => {
    let filtered = [...logs];

    // In history mode level/plugin/time/search are applied on backend.
    // In live mode apply all filters client-side.
    if (viewMode !== 'history') {
      if (runIdFilter) {
        filtered = filtered.filter((log) => log.runId === runIdFilter);
      }
      if (executionIdFilter) {
        filtered = filtered.filter((log) => log.executionId === executionIdFilter);
      }
      if (levelFilter) {
        filtered = filtered.filter((log) => log.level === levelFilter);
      }

      if (pluginFilter) {
        filtered = filtered.filter((log) => log.plugin === pluginFilter);
      }

      if (timeRange === 'custom') {
        if (customTimeRange) {
          const [start, end] = customTimeRange;
          filtered = filtered.filter((log) => {
            const logTime = dayjs(log.time);
            return logTime.isAfter(start) && logTime.isBefore(end);
          });
        }
      } else if (timeRange !== 'all') {
        const rangeMinutes = TIME_RANGES[timeRange as keyof typeof TIME_RANGES]?.minutes ?? 15;
        const cutoff = Date.now() - rangeMinutes * 60 * 1000;
        filtered = filtered.filter((log) => new Date(log.time).getTime() >= cutoff);
      }

      if (searchQuery.trim()) {
        const query = searchQuery.trim().toLowerCase();
        filtered = filtered.filter((log) => {
          const haystack = [
            String(log.msg ?? ''),
            String(log.plugin ?? ''),
            String(log.trace ?? log['traceId'] ?? ''),
            String(log.executionId ?? ''),
            JSON.stringify(log.meta ?? {}),
          ].join(' ').toLowerCase();
          return haystack.includes(query);
        });
      }
    }

    return filtered;
  }, [logs, viewMode, levelFilter, pluginFilter, timeRange, customTimeRange, searchQuery]);

  // Calculate statistics (for AI summarization)
  const stats = useMemo(() => calculateLogStats(filteredLogs), [filteredLogs]);

  // Get unique plugins for filter dropdown
  const uniquePlugins = useMemo(() => {
    return Array.from(new Set([...streamLogs, ...historyLogs].map((log) => log.plugin).filter(Boolean)));
  }, [streamLogs, historyLogs]);

  // Group logs if needed
  const groupedLogs = useMemo(() => {
    if (groupBy === 'none') {return null;}

    switch (groupBy) {
      case 'trace':
        return groupLogsByField(filteredLogs, 'traceId');
      case 'execution':
        return groupLogsByField(filteredLogs, 'executionId');
      case 'plugin':
        return groupLogsByField(filteredLogs, 'plugin');
      default:
        return null;
    }
  }, [filteredLogs, groupBy]);

  /**
   * Render grouped logs
   */
  const renderGroupedLogs = () => {
    if (!groupedLogs) {return null;}

    const groups = Array.from(groupedLogs.entries());

    return (
      <UIAccordion
        ghost
        items={groups.map(([key, groupLogs]) => ({
          key,
          label: `${key} (${groupLogs.length} logs)`,
          children: (
            <div>
              {groupLogs.map((log, index) => (
                <LogRow key={`${log.time}-${index}`} log={log} />
              ))}
            </div>
          ),
        }))}
      />
    );
  };

  /**
   * Handle AI Summarization
   */
  const handleSummarize = async () => {
    setSummarizing(true);
    setSummaryResult(null);

    try {
      // Build request
      const request = {
        question: customQuestion,
        includeContext,
        timeRange: resolveLogTimeRange(timeRange, customTimeRange),
        filters: {
          level: levelFilter || undefined,
          plugin: pluginFilter || undefined,
          runId: runIdFilter || undefined,
          executionId: executionIdFilter || undefined,
        },
        groupBy: groupBy !== 'none' ? groupBy : undefined,
      };

      // Call API through data source
      // Note: HttpClient auto-unwraps { ok: true, data: {...} } envelope
      const result = await sources.observability.summarizeLogs(request);

      // Store the full result data for structured rendering
      setSummaryResult(result.data);
    } catch (err: any) {
      UIMessage.error('Failed to generate summary: ' + err.message);
    } finally {
      setSummarizing(false);
    }
  };

  /**
   * Open AI Summarize modal
   */
  const openSummarizeModal = () => {
    setSummarizeModalOpen(true);
    setSummaryResult(null);
    setCustomQuestion('');
  };

  return (
    <UIPage width="full">
      <UIPageHeader
        title="Live Logs"
        description="Real-time application logs with AI-ready filtering and grouping"
        actions={
          <UIButton
            variant="primary"
            icon={<UIIcon name="RobotOutlined" />}
            onClick={openSummarizeModal}
            disabled={filteredLogs.length === 0}
          >
            AI Summarize
          </UIButton>
        }
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 24 }}>
        {/* Connection Status */}
        {!isConnected && !error && viewMode === 'live' && (
          <UIAlert
            message="Connecting to log stream..."
            variant="info"
            showIcon
            icon={<UIIcon name="SyncOutlined" spin />}
          />
        )}

        {error && viewMode === 'live' && (
          <UIAlert
            message="Connection failed"
            description={error.message + ' - Make sure REST API is running on localhost:5050'}
            variant="error"
            showIcon
          />
        )}

        {viewMode === 'history' && historyError && (
          <UIAlert
            message="Observability logs unavailable"
            description="Source: REST API observability logs. Run kb-create doctor --platform-root <platform-root> to diagnose the unavailable service."
            variant="error"
            showIcon
          />
        )}

        {/* Toolbar — one row, no labels, placeholders do the talking */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <UISegmented
            value={viewMode}
            onChange={(value) => setViewMode(value as 'live' | 'history')}
            options={[
              { label: 'Live', value: 'live' },
              { label: 'History', value: 'history' },
            ]}
          />
          <UIInput
            value={searchQuery}
            onChange={(value: string) => setSearchQuery(value)}
            placeholder={viewMode === 'history' ? 'Search history…' : 'Search live logs…'}
            allowClear
            prefix={<UIIcon name="SearchOutlined" style={{ color: 'var(--text-tertiary)' }} />}
            style={{ flex: '1 1 220px', minWidth: 180 }}
          />
          <UISelect
            style={{ width: 130 }}
            placeholder="All levels"
            allowClear
            value={levelFilter ?? undefined}
            onChange={(v) => setLevelFilter(v as string | null)}
            options={[
              { label: 'Trace', value: 'trace' },
              { label: 'Debug', value: 'debug' },
              { label: 'Info', value: 'info' },
              { label: 'Warning', value: 'warn' },
              { label: 'Error', value: 'error' },
            ]}
          />
          <UISelect
            style={{ width: 150 }}
            placeholder="All plugins"
            allowClear
            value={pluginFilter ?? undefined}
            onChange={(v) => setPluginFilter(v as string | null)}
            options={uniquePlugins.map((plugin) => ({ label: String(plugin), value: String(plugin) }))}
          />
          <UISelect
            style={{ width: 150 }}
            value={timeRange}
            onChange={(v) => setTimeRange(v as string)}
            options={Object.entries(TIME_RANGES).map(([key, { label }]) => ({ label, value: key }))}
          />
          <UISelect
            style={{ width: 150 }}
            value={groupBy}
            onChange={(v) => setGroupBy(v as 'none' | 'trace' | 'plugin' | 'execution')}
            options={[
              { label: 'No grouping', value: 'none' },
              { label: 'Trace ID', value: 'trace' },
              { label: 'Execution ID', value: 'execution' },
              { label: 'Plugin', value: 'plugin' },
            ]}
          />
        </div>

        {timeRange === 'custom' && (
          <UIRangePicker
            showTime
            style={{ width: 340 }}
            onChange={(dates) => setCustomTimeRange(dates as [Dayjs, Dayjs] | null)}
          />
        )}

        {/* Headline stats — the numbers you check first */}
        <AnalyticsSummaryStrip
          metrics={[
            { label: 'Total', value: viewMode === 'history' ? historyTotal : filteredLogs.length },
            { label: 'Errors', value: stats.errorCount, valueColor: stats.errorCount > 0 ? 'var(--error)' : undefined },
            { label: 'Warnings', value: stats.warningCount, valueColor: stats.warningCount > 0 ? 'var(--warning)' : undefined },
            { label: 'Unique Traces', value: stats.uniqueTraces.size },
            { label: 'Unique Executions', value: stats.uniqueExecutions.size },
          ]}
        />

        {viewMode === 'history' && (
          <UITypographyText type="secondary" style={{ fontSize: 12 }}>
            {historySource
              ? `Source: ${historySource}${historyStats?.persistence ? ` · persisted logs: ${historyStats.persistence.totalLogs}` : ''}`
              : 'Showing stored logs with server-side filtering and search'}
          </UITypographyText>
        )}

        {/* Logs — dense rows, no card framing, just a bordered panel */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <UISpace size="small">
              <UITypographyText strong>
                {groupBy === 'none'
                  ? (viewMode === 'history' ? 'Historical Logs' : 'Recent Logs')
                  : `Logs grouped by ${groupBy}`}
              </UITypographyText>
              <UIBadge
                count={viewMode === 'history' ? historyTotal : filteredLogs.length}
                showZero
                style={{ backgroundColor: 'var(--text-tertiary)' }}
              />
            </UISpace>
            <UISpace>
              {viewMode === 'live' ? (
                <>
                  <UIButton
                    size="small"
                    icon={isPaused ? <UIIcon name="SyncOutlined" /> : <UIIcon name="ClockCircleOutlined" />}
                    onClick={() => setIsPaused(!isPaused)}
                    variant={isPaused ? 'primary' : 'default'}
                  >
                    {isPaused ? 'Resume' : 'Pause'}
                  </UIButton>
                  <UIButton size="small" onClick={clearLogs}>
                    Clear
                  </UIButton>
                </>
              ) : (
                <UIButton
                  size="small"
                  icon={<UIIcon name="ReloadOutlined" />}
                  loading={historyLoading}
                  onClick={() => setHistoryRefreshToken((v) => v + 1)}
                >
                  Refresh
                </UIButton>
              )}
            </UISpace>
          </div>

          <div style={{ border: '1px solid var(--border-primary)', borderRadius: 10, overflow: 'hidden' }}>
            {viewMode === 'history' && historyLoading ? (
              <div style={{ textAlign: 'center', padding: '40px 0' }}>
                <UISpin tip="Loading historical logs..." />
              </div>
            ) : filteredLogs.length === 0 ? (
              <UIAlert
                message="No logs match current filters"
                description={
                  viewMode === 'history'
                    ? 'Adjust filters or search query for historical data'
                    : 'Adjust filters or wait for new logs to arrive'
                }
                variant="info"
                showIcon
                style={{ border: 'none' }}
              />
            ) : groupBy === 'none' ? (
              <div style={{ maxHeight: 640, overflow: 'auto' }}>
                <UIList
                  split={false}
                  dataSource={filteredLogs}
                  renderItem={(log, index) => (
                    <UIListItem style={{ padding: 0, display: 'block' }}>
                      <LogRow key={`${log.time}-${index}`} log={log} />
                    </UIListItem>
                  )}
                  pagination={
                    viewMode === 'history'
                      ? {
                          current: historyPage,
                          total: historyTotal,
                          pageSize: historyPageSize,
                          showSizeChanger: true,
                          pageSizeOptions: ['25', '50', '100', '200'],
                          showTotal: (total: number, range: [number, number]) =>
                            `Showing ${range[0]}-${range[1]} of ${total} logs`,
                          onChange: (page: number, pageSize: number) => {
                            if (pageSize !== historyPageSize) {
                              setHistoryPageSize(pageSize);
                              setHistoryPage(1);
                            } else {
                              setHistoryPage(page);
                            }
                          },
                        }
                      : filteredLogs.length > 50
                      ? {
                          pageSize: 50,
                          showSizeChanger: true,
                          showTotal: (total: number) => `Total ${total} logs`,
                          pageSizeOptions: ['25', '50', '100', '200'],
                        }
                      : false
                  }
                />
              </div>
            ) : (
              renderGroupedLogs()
            )}
          </div>
        </div>
      </div>

      {/* AI Summarize Modal */}
      <UIModal
        title={
          <UISpace>
            <UIIcon name="RobotOutlined" />
            <span>AI Log Summarization</span>
          </UISpace>
        }
        open={summarizeModalOpen}
        onCancel={() => setSummarizeModalOpen(false)}
        width={800}
        footer={[
          <UIButton key="cancel" onClick={() => setSummarizeModalOpen(false)}>
            Cancel
          </UIButton>,
          <UIButton
            key="summarize"
            variant="primary"
            icon={<UIIcon name="ThunderboltOutlined" />}
            loading={summarizing}
            onClick={handleSummarize}
            disabled={!customQuestion.trim()}
          >
            Generate Summary
          </UIButton>,
        ]}
      >
        <UISpace direction="vertical" style={{ width: '100%' }} size="large">
          {/* Data Preview */}
          <UICard size="small" style={{ backgroundColor: 'var(--bg-tertiary)' }}>
            <UIRow gutter={16}>
              <UICol span={6}>
                <UITypographyText type="secondary">Logs to analyze:</UITypographyText>
                <div>
                  <UITypographyText strong>{filteredLogs.length}</UITypographyText>
                </div>
              </UICol>
              <UICol span={6}>
                <UITypographyText type="secondary">Errors:</UITypographyText>
                <div>
                  <UITypographyText type="danger" strong>
                    {stats.errorCount}
                  </UITypographyText>
                </div>
              </UICol>
              <UICol span={6}>
                <UITypographyText type="secondary">Warnings:</UITypographyText>
                <div>
                  <UITypographyText type="warning" strong>
                    {stats.warningCount}
                  </UITypographyText>
                </div>
              </UICol>
              <UICol span={6}>
                <UITypographyText type="secondary">Time range:</UITypographyText>
                <div>
                  <UITypographyText strong>{TIME_RANGES[timeRange as keyof typeof TIME_RANGES]?.label}</UITypographyText>
                </div>
              </UICol>
            </UIRow>
          </UICard>

          {/* Quick Templates */}
          <div>
            <UITypographyText strong>Quick Questions:</UITypographyText>
            <div style={{ marginTop: 8 }}>
              <UISpace wrap>
                {QUESTION_TEMPLATES.map((template) => (
                  <UIButton
                    key={template.label}
                    size="small"
                    onClick={() => setCustomQuestion(template.value)}
                  >
                    {template.label}
                  </UIButton>
                ))}
              </UISpace>
            </div>
          </div>

          <UIDivider style={{ margin: '8px 0' }} />

          {/* Custom Question */}
          <div>
            <UITypographyText strong>Your Question:</UITypographyText>
            <UIInputTextArea
              value={customQuestion}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setCustomQuestion(e.target.value)}
              placeholder="Ask anything about these logs... (e.g., 'What went wrong in the last 5 minutes?')"
              rows={3}
              style={{ marginTop: 8 }}
            />
          </div>

          {/* Context Options */}
          <div>
            <UITypographyText strong>Include in context:</UITypographyText>
            <div style={{ marginTop: 8 }}>
              <UISpace direction="vertical">
                <UICheckbox
                  checked={includeContext.errors}
                  onChange={(checked) =>
                    setIncludeContext({ ...includeContext, errors: checked })
                  }
                >
                  Error messages and stack traces
                </UICheckbox>
                <UICheckbox
                  checked={includeContext.warnings}
                  onChange={(checked) =>
                    setIncludeContext({ ...includeContext, warnings: checked })
                  }
                >
                  Warning messages
                </UICheckbox>
                <UICheckbox
                  checked={includeContext.info}
                  onChange={(checked) =>
                    setIncludeContext({ ...includeContext, info: checked })
                  }
                >
                  Info-level logs
                </UICheckbox>
                <UICheckbox
                  checked={includeContext.metadata}
                  onChange={(checked) =>
                    setIncludeContext({ ...includeContext, metadata: checked })
                  }
                >
                  Metadata (traceId, executionId, etc.)
                </UICheckbox>
                <UICheckbox
                  checked={includeContext.stackTraces}
                  onChange={(checked) =>
                    setIncludeContext({ ...includeContext, stackTraces: checked })
                  }
                >
                  Full stack traces
                </UICheckbox>
              </UISpace>
            </div>
          </div>

          {/* Summary Result */}
          {summarizing && (
            <div style={{ textAlign: 'center', padding: '24px 0' }}>
              <UISpin tip="Analyzing logs with AI..." size="large" />
            </div>
          )}

          {summaryResult && !summarizing && (
            <UISpace direction="vertical" size="middle" style={{ width: '100%', marginTop: 16 }}>
              {/* Statistics Card */}
              <UICard
                title={
                  <UISpace>
                    <UIIcon name="InfoCircleOutlined" />
                    <span>Statistics</span>
                  </UISpace>
                }
                size="small"
              >
                <UIDescriptions column={2} size="small">
                  <UIDescriptionsItem label="Total Logs">{summaryResult.summary.total}</UIDescriptionsItem>
                  <UIDescriptionsItem label="Time Range">
                    {summaryResult.summary.timeRange.from && summaryResult.summary.timeRange.to
                      ? `${summaryResult.summary.timeRange.from} to ${summaryResult.summary.timeRange.to}`
                      : 'All time'}
                  </UIDescriptionsItem>
                </UIDescriptions>

                {/* Level breakdown */}
                {summaryResult.summary.stats?.byLevel && Object.keys(summaryResult.summary.stats.byLevel).length > 0 && (
                  <>
                    <UIDivider style={{ margin: '12px 0' }} />
                    <UITypographyText strong>By Level:</UITypographyText>
                    <div style={{ marginTop: 8 }}>
                      <UISpace wrap>
                        {Object.entries(summaryResult.summary.stats.byLevel).map(([level, count]) => (
                          <UITag key={level} color={
                            level === 'error' ? 'red' :
                            level === 'warn' ? 'orange' :
                            level === 'info' ? 'blue' :
                            'default'
                          }>
                            {level}: {count}
                          </UITag>
                        ))}
                      </UISpace>
                    </div>
                  </>
                )}

                {/* Plugin breakdown */}
                {summaryResult.summary.stats?.byPlugin && Object.keys(summaryResult.summary.stats.byPlugin).length > 0 && (
                  <>
                    <UIDivider style={{ margin: '12px 0' }} />
                    <UITypographyText strong>By Plugin (Top 5):</UITypographyText>
                    <div style={{ marginTop: 8 }}>
                      <UISpace wrap>
                        {Object.entries(summaryResult.summary.stats.byPlugin)
                          .sort((a: any, b: any) => b[1] - a[1])
                          .slice(0, 5)
                          .map(([plugin, count]) => (
                            <UITag key={plugin}>{plugin}: {count}</UITag>
                          ))}
                      </UISpace>
                    </div>
                  </>
                )}
              </UICard>

              {/* Top Errors Card */}
              {summaryResult.summary.stats?.topErrors && summaryResult.summary.stats.topErrors.length > 0 && (
                <UICard
                  title={
                    <UISpace>
                      <UIIcon name="BugOutlined" />
                      <span>Top Errors</span>
                    </UISpace>
                  }
                  size="small"
                >
                  <UIList
                    size="small"
                    dataSource={summaryResult.summary.stats.topErrors.slice(0, 5)}
                    renderItem={(err: any, idx: number) => (
                      <UIListItem>
                        <UITypographyText>
                          <UITypographyText type="secondary">{idx + 1}.</UITypographyText>{' '}
                          <UITypographyText code>{err.message}</UITypographyText>{' '}
                          <UITypographyText type="secondary">({err.count} times)</UITypographyText>
                        </UITypographyText>
                      </UIListItem>
                    )}
                  />
                </UICard>
              )}

              {/* AI Analysis Card */}
              {summaryResult.aiSummary && (
                <UIAlert
                  variant="info"
                  showIcon
                  icon={<UIIcon name="RobotOutlined" />}
                  message="AI Analysis"
                  description={
                    <UISpace direction="vertical" size="small" style={{ width: '100%' }}>
                      {summaryResult.aiSummary.split('\n\n').map((paragraph, idx) => (
                        <UITypographyParagraph key={idx} style={{ marginBottom: 0 }}>
                          {paragraph}
                        </UITypographyParagraph>
                      ))}
                    </UISpace>
                  }
                />
              )}

              {/* Info message if AI not available */}
              {!summaryResult.aiSummary && summaryResult.message && (
                <UIAlert
                  message={summaryResult.message}
                  variant="info"
                  showIcon
                />
              )}
            </UISpace>
          )}
        </UISpace>
      </UIModal>
    </UIPage>
  );
}
