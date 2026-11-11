import * as React from 'react';
import {
  UICard, UITag, UIAlert,
  UISkeleton, UISpace, UITable,
  useData, useTheme,
} from '@kb-labs/sdk/studio';
import type { StatsSnapshot, BaselineCheckDiff } from '../../contracts/index.js';
import { QA_BASE_PATH, QA_ROUTES } from '../../contracts/index.js';

type SummaryResponse = {
  latestStats: StatsSnapshot | null;
  baseline: { timestamp: string; stats: { score: number; grade: string } } | null;
};

function gradeTagColor(grade: string): string {
  if (grade === 'A' || grade === 'A+') return 'success';
  if (grade === 'B') return 'processing';
  if (grade === 'C') return 'warning';
  return 'error';
}

function gradeValueColor(grade: string, token: ReturnType<typeof useTheme>['antdToken']): string {
  if (grade === 'A' || grade === 'A+') return token.colorSuccess;
  if (grade === 'B') return token.colorPrimary;
  if (grade === 'C') return token.colorWarning;
  return token.colorError;
}

export function HealthTab() {
  const { antdToken: token } = useTheme();

  const { data: summary, isLoading: summaryLoading } = useData<SummaryResponse>(
    `${QA_BASE_PATH}${QA_ROUTES.SUMMARY}`,
  );

  const { data: diff, isLoading: diffLoading } = useData<BaselineCheckDiff | { error: string }>(
    `${QA_BASE_PATH}${QA_ROUTES.BASELINE_DIFF}`,
  );

  if (summaryLoading || diffLoading) {
    return <UISkeleton active lines={5} />;
  }

  const stats = summary?.latestStats?.raw;

  if (!stats) {
    return (
      <UIAlert
        variant="info"
        showIcon
        message="No health data"
        description="Run 'kb qa stats show' to collect health data."
        style={{ marginBottom: token.marginLG }}
      />
    );
  }

  const hasDiff = diff && !('error' in diff) && (diff.newIssueCount > 0 || diff.fixedIssueCount > 0);
  const validDiff = diff && !('error' in diff) ? diff : null;

  const categoryRows = Object.entries(stats.by_category).map(([cat, data]) => ({
    key: cat,
    category: cat,
    total: data.total,
    healthy: data.healthy,
    issues: data.issues,
    grade: data.grade,
    pct: data.total > 0 ? Math.round((data.healthy / data.total) * 100) : 0,
  }));

  const coverageRows = Object.entries(stats.coverage).map(([k, v]) => ({
    key: k,
    name: k,
    pass: v.pass,
    total: v.total,
    pct: v.pct,
  }));

  const issueTypeRows = Object.entries(stats.issues_by_type).map(([k, v]) => ({
    key: k,
    check: v.check,
    errors: v.errors,
    warnings: v.warnings,
    packages: v.packages,
  }));

  return (
    <UISpace direction="vertical" style={{ width: '100%' }} size="large">

      {/* Baseline diff banner */}
      {hasDiff && validDiff && (
        <UIAlert
          variant={validDiff.newIssueCount > 0 ? 'error' : 'success'}
          showIcon
          message={
            <UISpace>
              {validDiff.newIssueCount > 0 && (
                <UITag color="error">{validDiff.newIssueCount} new issues</UITag>
              )}
              {validDiff.fixedIssueCount > 0 && (
                <UITag color="success">{validDiff.fixedIssueCount} fixed</UITag>
              )}
              <UITag color={validDiff.scoreDelta >= 0 ? 'green' : 'red'}>
                score {validDiff.scoreDelta > 0 ? '+' : ''}{validDiff.scoreDelta}
              </UITag>
              <UITag>{validDiff.gradeDelta}</UITag>
            </UISpace>
          }
        />
      )}

      {/* Score strip — single row, not four separate cards */}
      <UICard styles={{ body: { padding: '18px 24px' } }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{
              fontSize: 28, fontWeight: 700, fontFamily: 'var(--font-heading)',
              fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.01em',
              color: gradeValueColor(stats.grade, token),
            }}>
              {stats.score}
            </span>
            <span style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>/ 100 health score</span>
            <UITag color={gradeTagColor(stats.grade)}>{stats.grade}</UITag>
          </div>
          {[
            { label: 'Healthy', value: stats.summary.healthy, color: token.colorSuccess },
            { label: 'Warning', value: stats.summary.warning, color: token.colorWarning },
            { label: 'Error', value: stats.summary.error, color: token.colorError },
          ].map((metric) => (
            <div key={metric.label} style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
              <span style={{ width: 1, alignSelf: 'stretch', background: 'var(--border-primary)' }} />
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                <span style={{
                  fontSize: 20, fontWeight: 700, fontFamily: 'var(--font-heading)',
                  fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.01em',
                  color: metric.color,
                }}>
                  {metric.value}
                </span>
                <span style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>{metric.label}</span>
              </div>
            </div>
          ))}
        </div>
      </UICard>

      {/* Category breakdown */}
      <UICard title="By Category">
        <UITable
          dataSource={categoryRows}
          size="small"
          pagination={false}
          columns={[
            { title: 'Category', dataIndex: 'category', key: 'category' },
            {
              title: 'Grade',
              dataIndex: 'grade',
              key: 'grade',
              render: (g: string) => (
                <UITag color={gradeTagColor(g)}>{g}</UITag>
              ),
            },
            { title: 'Healthy', dataIndex: 'healthy', key: 'healthy' },
            { title: 'Total', dataIndex: 'total', key: 'total' },
            { title: 'Issues', dataIndex: 'issues', key: 'issues' },
            {
              title: 'Coverage',
              dataIndex: 'pct',
              key: 'pct',
              render: (pct: number) => `${pct}%`,
            },
          ]}
        />
      </UICard>

      {/* Coverage */}
      {coverageRows.length > 0 && (
        <UICard title="Coverage">
          <UITable
            dataSource={coverageRows}
            size="small"
            pagination={false}
            columns={[
              { title: 'Check', dataIndex: 'name', key: 'name' },
              { title: 'Pass', dataIndex: 'pass', key: 'pass' },
              { title: 'Total', dataIndex: 'total', key: 'total' },
              {
                title: 'Pct',
                dataIndex: 'pct',
                key: 'pct',
                render: (pct: number) => (
                  <UITag color={pct >= 80 ? 'green' : pct >= 50 ? 'orange' : 'red'}>{pct}%</UITag>
                ),
              },
            ]}
          />
        </UICard>
      )}

      {/* Issues by type */}
      {issueTypeRows.length > 0 && (
        <UICard title="Issues by Type">
          <UITable
            dataSource={issueTypeRows}
            size="small"
            pagination={false}
            columns={[
              { title: 'Check', dataIndex: 'check', key: 'check' },
              { title: 'Errors', dataIndex: 'errors', key: 'errors',
                render: (n: number) => n > 0 ? <UITag color="red">{n}</UITag> : <UITag>0</UITag> },
              { title: 'Warnings', dataIndex: 'warnings', key: 'warnings',
                render: (n: number) => n > 0 ? <UITag color="orange">{n}</UITag> : <UITag>0</UITag> },
              { title: 'Packages', dataIndex: 'packages', key: 'packages' },
            ]}
          />
        </UICard>
      )}

      {/* Baseline new issues */}
      {validDiff && validDiff.newIssues.length > 0 && (
        <UICard title={`New Issues (${validDiff.newIssues.length})`}>
          <UITable
            dataSource={validDiff.newIssues.map((i, idx) => ({ ...i, key: idx }))}
            size="small"
            pagination={{ pageSize: 10 }}
            columns={[
              { title: 'Package', dataIndex: 'pkg', key: 'pkg' },
              { title: 'Check', dataIndex: 'check', key: 'check' },
              {
                title: 'Severity',
                dataIndex: 'severity',
                key: 'severity',
                render: (s: string) => (
                  <UITag color={s === 'error' ? 'red' : s === 'warning' ? 'orange' : 'blue'}>{s}</UITag>
                ),
              },
              { title: 'Message', dataIndex: 'message', key: 'message' },
            ]}
          />
        </UICard>
      )}

    </UISpace>
  );
}
