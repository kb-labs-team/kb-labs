/**
 * Issues-by-type panel using DevkitStatsOutput.issues_by_type.
 * Shows check types with error/warning counts and package impact.
 */

import * as React from 'react';
import {
  UICard,
  UITable,
  UITag,
  UITypographyText,
  UISpace,
  UIBadge,
  UISkeleton,
  UIIcon,
  useData,
  useTheme,
} from '@kb-labs/sdk/studio';
import type { DevkitStatsIssueType, StatsSnapshot } from '../../contracts/index.js';
import { QA_BASE_PATH, QA_ROUTES } from '../../contracts/index.js';

/** Summary endpoint shape as documented in the REST API contract. */
interface SummaryResponse {
  latestRun: unknown;
  latestCheck: unknown;
  latestStats: StatsSnapshot | null;
  baseline: unknown;
}

interface IssueTypeRow extends DevkitStatsIssueType {
  key: string;
}

export function ErrorGroupsPanel() {
  const { antdToken: token } = useTheme();

  const { data: summaryData, isLoading } = useData<SummaryResponse>(
    `${QA_BASE_PATH}${QA_ROUTES.SUMMARY}`,
  );

  if (isLoading) {
    return <UISkeleton active lines={5} />;
  }

  const latestStats = summaryData?.latestStats ?? null;
  if (!latestStats) { return null; }

  const issuesByType = latestStats.raw.issues_by_type;
  const rows: IssueTypeRow[] = Object.entries(issuesByType).map(([key, val]) => ({ key, ...val }));

  if (rows.length === 0) { return null; }

  const columns = [
    {
      title: 'Check',
      dataIndex: 'check',
      key: 'check',
      render: (check: string) => (
        <UITypographyText code style={{ fontSize: token.fontSizeSM }}>{check}</UITypographyText>
      ),
    },
    {
      title: 'Errors',
      dataIndex: 'errors',
      key: 'errors',
      width: 90,
      sorter: (a: IssueTypeRow, b: IssueTypeRow) => a.errors - b.errors,
      defaultSortOrder: 'descend' as const,
      render: (errors: number) => (
        errors > 0
          ? <UIBadge count={errors} style={{ backgroundColor: token.colorError }} />
          : <span style={{ color: token.colorTextSecondary }}>—</span>
      ),
    },
    {
      title: 'Warnings',
      dataIndex: 'warnings',
      key: 'warnings',
      width: 100,
      sorter: (a: IssueTypeRow, b: IssueTypeRow) => a.warnings - b.warnings,
      render: (warnings: number) => (
        warnings > 0
          ? <UIBadge count={warnings} style={{ backgroundColor: token.colorWarning }} />
          : <span style={{ color: token.colorTextSecondary }}>—</span>
      ),
    },
    {
      title: 'Packages Affected',
      dataIndex: 'packages',
      key: 'packages',
      width: 150,
      sorter: (a: IssueTypeRow, b: IssueTypeRow) => a.packages - b.packages,
      render: (packages: number) => (
        <UISpace>
          <UIBadge count={packages} style={{ backgroundColor: packages > 5 ? token.colorError : packages > 2 ? token.colorWarning : token.colorSuccess }} />
          <span style={{ fontSize: token.fontSizeSM, color: token.colorTextSecondary }}>packages</span>
        </UISpace>
      ),
    },
    {
      title: 'Impact',
      key: 'impact',
      width: 90,
      render: (_: unknown, record: IssueTypeRow) => {
        const total = record.errors + record.warnings;
        if (total === 0) { return <UITag>Clean</UITag>; }
        if (record.errors > 0) { return <UITag color="error">High</UITag>; }
        return <UITag color="warning">Medium</UITag>;
      },
    },
  ];

  const totalErrors = rows.reduce((s, r) => s + r.errors, 0);
  const totalWarnings = rows.reduce((s, r) => s + r.warnings, 0);

  return (
    <UICard
      title={
        <UISpace>
          <UIIcon name="BugOutlined" />
          <span>Issues by Type</span>
          {totalErrors > 0 && <UITag color="error">{totalErrors} errors</UITag>}
          {totalWarnings > 0 && <UITag color="warning">{totalWarnings} warnings</UITag>}
        </UISpace>
      }
    >
      <UITable<IssueTypeRow>
        dataSource={rows}
        columns={columns}
        rowKey="key"
        size="small"
        pagination={rows.length > 10 ? { pageSize: 10 } : false}
      />
    </UICard>
  );
}
