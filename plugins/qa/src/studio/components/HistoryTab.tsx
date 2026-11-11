/**
 * History tab - table of past QA runs with task columns derived dynamically.
 */

import * as React from 'react';
import { UITable, UITag, UISkeleton, UIAlert, UISpace, UIIcon, UIFlex, useData, useTheme, type UITableColumn } from '@kb-labs/sdk/studio';
import type { QAHistoryResponse, RunSnapshot } from '../../contracts/index.js';
import { QA_BASE_PATH, QA_ROUTES } from '../../contracts/index.js';

function renderTaskColumn(snapshot: RunSnapshot, task: string) {
  const results = (snapshot.raw.results ?? []).filter(r => r.Task === task);
  if (results.length === 0) { return <span style={{ color: '#999' }}>—</span>; }
  const failed = results.filter(r => !r.OK && !r.Cached).length;
  const cached = results.filter(r => r.Cached).length;
  const passed = results.filter(r => r.OK && !r.Cached).length;
  if (failed > 0) {
    return (
      <UITag color="error" style={{ fontVariantNumeric: 'tabular-nums' }}>
        {passed}/{results.length}
      </UITag>
    );
  }
  if (cached > 0) {
    return (
      <UITag color="default" style={{ fontVariantNumeric: 'tabular-nums' }}>
        {cached} cached
      </UITag>
    );
  }
  return (
    <UITag color="success" style={{ fontVariantNumeric: 'tabular-nums' }}>
      {passed}/{results.length}
    </UITag>
  );
}

export function HistoryTab() {
  const { antdToken: token } = useTheme();
  const { data, isLoading } = useData<QAHistoryResponse>(`${QA_BASE_PATH}${QA_ROUTES.HISTORY}`);

  if (isLoading) {
    return <UISkeleton active lines={6} />;
  }

  if (!data || !data.snapshots || data.snapshots.length === 0) {
    return (
      <UIAlert
        variant="info"
        showIcon
        message="No QA history"
        description="Run 'kb qa run --save' to record QA results to history."
      />
    );
  }

  // Collect all unique tasks across snapshots
  const allTasks = [...new Set(data.snapshots.flatMap(s => s.tasks ?? []))];

  const columns: UITableColumn<RunSnapshot>[] = [
    {
      title: 'Date',
      dataIndex: 'timestamp',
      key: 'timestamp',
      width: 180,
      render: (ts: string) => new Date(ts).toLocaleString(),
      sorter: (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      defaultSortOrder: 'descend',
    },
    {
      title: 'Status',
      key: 'status',
      width: 100,
      render: (_, record) => {
        const ok = record.raw.ok;
        return (
          <UITag
            color={ok ? 'success' : 'error'}
            icon={ok ? <UIIcon name="CheckCircleOutlined" /> : <UIIcon name="CloseCircleOutlined" />}
          >
            {ok ? 'PASSED' : 'FAILED'}
          </UITag>
        );
      },
      filters: [
        { text: 'Passed', value: true },
        { text: 'Failed', value: false },
      ],
      onFilter: (value, record) => record.raw.ok === value,
    },
    {
      title: 'Git',
      key: 'git',
      width: 220,
      render: (_, record) => record.git ? (
        <UISpace direction="vertical" size={0}>
          <span><UIIcon name="BranchesOutlined" /> {record.git.branch}</span>
          <span style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM }}>
            {record.git.commit.slice(0, 7)} — {record.git.message.slice(0, 40)}
            {record.git.message.length > 40 ? '...' : ''}
          </span>
        </UISpace>
      ) : <span style={{ color: token.colorTextSecondary }}>—</span>,
    },
    {
      title: 'Total',
      key: 'total',
      width: 80,
      align: 'center',
      render: (_, record) => (
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>
          {record.raw.summary.passed}/{record.raw.summary.total}
        </span>
      ),
    },
    ...allTasks.map((task) => ({
      title: task,
      key: task,
      width: 90,
      align: 'center' as const,
      render: (_: unknown, record: RunSnapshot) => renderTaskColumn(record, task),
    })),
  ];

  return (
    <UITable<RunSnapshot>
      columns={columns}
      dataSource={data.snapshots}
      rowKey="id"
      pagination={{ pageSize: 15 }}
      size="middle"
      expandable={{
        expandedRowRender: (record) => {
          const failedResults = record.raw.results.filter(r => !r.OK && !r.Cached);
          if (failedResults.length === 0) { return null; }

          // Group by task
          const byTask = new Map<string, string[]>();
          for (const r of failedResults) {
            const arr = byTask.get(r.Task) ?? [];
            arr.push(r.Package);
            byTask.set(r.Task, arr);
          }

          return (
            <div style={{ padding: `${token.paddingXS}px ${token.paddingMD}px` }}>
              {[...byTask.entries()].map(([task, pkgs]) => (
                <div key={task} style={{ marginBottom: token.marginSM }}>
                  <strong>{task} failures ({pkgs.length}):</strong>
                  <UIFlex wrap="wrap" gap={1} style={{ marginTop: token.marginXXS }}>
                    {pkgs.map((pkg) => (
                      <UITag key={pkg} color="error" style={{ fontSize: token.fontSizeSM }}>{pkg}</UITag>
                    ))}
                  </UIFlex>
                </div>
              ))}
            </div>
          );
        },
        rowExpandable: (record) => record.raw.results.some(r => !r.OK && !r.Cached),
      }}
    />
  );
}
