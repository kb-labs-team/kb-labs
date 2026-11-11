/**
 * Trends tab — time-series chart, summary cards with velocity, changelog timeline.
 */

import * as React from 'react';
import {
  UICard, UIRow, UICol, UITag, UIStatistic, UISkeleton, UIAlert, UISpace, UISelect,
  UITimeline, UITimelineItem, UIEmptyState, UIIcon, UIStatisticsChart, UIFlex,
  useData, useTheme,
} from '@kb-labs/sdk/studio';
import type { TrendAnalysis, TaskTrend, TaskTrendChangelog } from '../../contracts/index.js';
import { QA_BASE_PATH, QA_ROUTES } from '../../contracts/index.js';

type AntToken = ReturnType<typeof useTheme>['antdToken'];

function getTrendColor(direction: string, token: AntToken): string {
  switch (direction) {
    case 'regression': return token.colorError;
    case 'improvement': return token.colorSuccess;
    default: return token.colorTextSecondary;
  }
}

function getTrendIcon(direction: string): React.ReactNode {
  switch (direction) {
    case 'regression': return <UIIcon name="ArrowUpOutlined" />;
    case 'improvement': return <UIIcon name="ArrowDownOutlined" />;
    default: return <UIIcon name="MinusOutlined" />;
  }
}

function getTrendTag(direction: string): React.ReactNode {
  switch (direction) {
    case 'regression': return <UITag color="error">Regression</UITag>;
    case 'improvement': return <UITag color="success">Improvement</UITag>;
    default: return <UITag>No Change</UITag>;
  }
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${mo}-${dd} ${hh}:${mm}`;
}

function buildChartData(tasks: TaskTrend[]) {
  const rows: Array<{ date: string; value: number; category: string }> = [];
  for (const trend of tasks) {
    for (const point of trend.timeSeries) {
      rows.push({ date: formatTimestamp(point.timestamp), value: point.failed, category: trend.task });
    }
  }
  return rows;
}

function buildMergedChangelog(tasks: TaskTrend[]) {
  const byCommit = new Map<string, {
    timestamp: string;
    gitCommit: string;
    gitMessage: string;
    changes: Array<{ task: string; entry: TaskTrendChangelog }>;
  }>();

  for (const trend of tasks) {
    for (const entry of trend.changelog) {
      let group = byCommit.get(entry.gitCommit);
      if (!group) {
        group = { timestamp: entry.timestamp, gitCommit: entry.gitCommit, gitMessage: entry.gitMessage, changes: [] };
        byCommit.set(entry.gitCommit, group);
      }
      group.changes.push({ task: trend.task, entry });
    }
  }

  return [...byCommit.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

export function TrendsTab() {
  const { antdToken: token } = useTheme();
  const [windowSize, setWindowSize] = React.useState<number | undefined>(undefined);

  const trendsUrl = windowSize
    ? `${QA_BASE_PATH}${QA_ROUTES.TRENDS}?window=${windowSize}`
    : `${QA_BASE_PATH}${QA_ROUTES.TRENDS}`;
  const { data, isLoading } = useData<TrendAnalysis>(trendsUrl);

  if (isLoading) {
    return <UISkeleton active lines={6} />;
  }

  if (!data || data.tasks.length === 0) {
    return (
      <UIAlert
        variant="info"
        showIcon
        message="Not enough data for trend analysis"
        description="Need at least 2 history entries. Run 'kb qa run --save' multiple times."
      />
    );
  }

  const chartData = buildChartData(data.tasks);
  const mergedChangelog = buildMergedChangelog(data.tasks);

  return (
    <div>
      {/* Window selector */}
      <UIFlex justify="between" align="center" style={{ marginBottom: token.marginMD }}>
        <span style={{ color: token.colorTextSecondary }}>
          Analyzing {data.historyCount} history entries (window: {data.window})
        </span>
        <UISpace>
          <span>Window size:</span>
          <UISelect
            value={windowSize ?? data.window}
            onChange={(val) => setWindowSize(val as number | undefined)}
            style={{ width: 80 }}
            options={[
              { label: '5', value: 5 },
              { label: '10', value: 10 },
              { label: '20', value: 20 },
              { label: '50', value: 50 },
            ]}
          />
        </UISpace>
      </UIFlex>

      {/* Time-series chart */}
      <UIStatisticsChart
        title="Failure Count Over Time"
        data={chartData}
        loading={false}
        xField="date"
        yField="value"
        colorField="category"
        height={300}
        showLegend={false}
        chartProps={{ legend: { position: 'top' } }}
      />

      {/* Summary Cards */}
      <UIRow gutter={[16, 16]} style={{ marginTop: token.marginMD }}>
        {data.tasks.map((trend) => (
          <UICol xs={24} sm={12} key={trend.task}>
            <UICard size="small">
              <UIRow align="middle" gutter={16}>
                <UICol flex="auto">
                  <UISpace>
                    <UIIcon name="ExperimentOutlined" />
                    <span style={{ fontWeight: 600, fontSize: token.fontSizeLG }}>
                      {trend.task}
                    </span>
                    {getTrendTag(trend.direction)}
                  </UISpace>
                </UICol>
              </UIRow>
              <UIRow gutter={16} style={{ marginTop: token.marginSM }}>
                <UICol span={6}>
                  <UIStatistic title="Previous" value={trend.previous} valueStyle={{ fontSize: token.fontSizeHeading4 }} />
                </UICol>
                <UICol span={6}>
                  <UIStatistic title="Current" value={trend.current} valueStyle={{ fontSize: token.fontSizeHeading4 }} />
                </UICol>
                <UICol span={6}>
                  <UIStatistic
                    title="Delta"
                    value={Math.abs(trend.delta)}
                    prefix={getTrendIcon(trend.direction)}
                    valueStyle={{ color: getTrendColor(trend.direction, token), fontSize: token.fontSizeHeading4 }}
                  />
                </UICol>
                <UICol span={6}>
                  <UIStatistic
                    title="Velocity"
                    value={Math.abs(trend.velocity)}
                    precision={1}
                    prefix={
                      trend.velocity > 0
                        ? <UIIcon name="ArrowUpOutlined" />
                        : trend.velocity < 0
                          ? <UIIcon name="ArrowDownOutlined" />
                          : <UIIcon name="MinusOutlined" />
                    }
                    suffix="/run"
                    valueStyle={{
                      color: trend.velocity > 0
                        ? token.colorError
                        : trend.velocity < 0
                          ? token.colorSuccess
                          : token.colorTextSecondary,
                      fontSize: token.fontSizeHeading4,
                    }}
                  />
                </UICol>
              </UIRow>
            </UICard>
          </UICol>
        ))}
      </UIRow>

      {/* Changelog Timeline */}
      <UICard title="Changelog — What Changed" style={{ marginTop: token.marginMD }}>
        {mergedChangelog.length === 0 ? (
          <UIEmptyState description="No changes detected between entries" />
        ) : (
          <UITimeline>
            {mergedChangelog.map((group) => {
              const totalNewFailures = group.changes.reduce((s, c) => s + c.entry.newFailures.length, 0);
              const totalFixed = group.changes.reduce((s, c) => s + c.entry.fixed.length, 0);
              const dotColor = totalNewFailures > totalFixed ? token.colorError : token.colorSuccess;

              return (
                <UITimelineItem key={group.gitCommit} color={dotColor}>
                  <div style={{ marginBottom: token.marginXXS }}>
                    <UITag style={{ fontFamily: 'monospace' }}>{group.gitCommit.slice(0, 7)}</UITag>
                    <span style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM }}>
                      {new Date(group.timestamp).toLocaleString()}
                    </span>
                  </div>
                  <div style={{ fontSize: token.fontSize, color: token.colorTextSecondary, marginBottom: token.marginXS }}>
                    {group.gitMessage}
                  </div>
                  {group.changes.map(({ task, entry }) => (
                    <div key={task} style={{ marginBottom: token.marginXXS }}>
                      <span style={{ fontWeight: 500 }}>{task}:</span>
                      {entry.newFailures.length > 0 && (
                        <span style={{ marginLeft: 8 }}>
                          <UITag color="error" style={{ fontSize: token.fontSizeSM }}>+{entry.newFailures.length} new</UITag>
                          {entry.newFailures.map((pkg) => (
                            <UITag key={pkg} color="red" style={{ fontSize: token.fontSizeSM }}>{pkg}</UITag>
                          ))}
                        </span>
                      )}
                      {entry.fixed.length > 0 && (
                        <span style={{ marginLeft: 8 }}>
                          <UITag color="success" style={{ fontSize: token.fontSizeSM }}>-{entry.fixed.length} fixed</UITag>
                          {entry.fixed.map((pkg) => (
                            <UITag key={pkg} color="green" style={{ fontSize: token.fontSizeSM }}>{pkg}</UITag>
                          ))}
                        </span>
                      )}
                    </div>
                  ))}
                </UITimelineItem>
              );
            })}
          </UITimeline>
        )}
      </UICard>
    </div>
  );
}
