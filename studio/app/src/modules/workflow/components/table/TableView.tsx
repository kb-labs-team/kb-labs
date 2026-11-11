/**
 * Table view for workflow runs — sortable, filterable list.
 * Extracted from WorkflowsRuns.tsx to be used as one of the view modes.
 */

import { useMemo } from 'react';
import {
  UITable, UITypographyText } from '@kb-labs/studio-ui-kit';
import type { UITableColumn } from '@kb-labs/studio-ui-kit';
import type { WorkflowRun } from '@kb-labs/workflow-contracts';
import { WorkflowStatusBadge } from '../shared/WorkflowStatusBadge';

function formatDate(dateStr?: string) {
  if (!dateStr) { return '-'; }
  return new Date(dateStr).toLocaleString();
}

function formatDuration(run: WorkflowRun) {
  if (!run.startedAt) { return '-'; }
  const start = new Date(run.startedAt).getTime();
  const end = run.finishedAt ? new Date(run.finishedAt).getTime() : Date.now();
  const ms = end - start;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) { return `${seconds}s`; }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) { return `${minutes}m ${seconds % 60}s`; }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

interface TableViewProps {
  runs: WorkflowRun[];
  loading: boolean;
  onRunClick: (runId: string) => void;
}

export function TableView({ runs, loading, onRunClick }: TableViewProps) {
  const columns = useMemo<UITableColumn<WorkflowRun>[]>(
    () => [
      {
        title: 'Run ID',
        dataIndex: 'id',
        key: 'id',
        width: 180,
        render: (value: string) => (
          <UITypographyText className="typo-caption" code ellipsis={{ tooltip: value }}>
            {value.slice(0, 16)}...
          </UITypographyText>
        ),
      },
      {
        title: 'Workflow',
        dataIndex: 'name',
        key: 'name',
        width: 220,
        render: (_value: unknown, record: WorkflowRun) => (
          <UITypographyText className="typo-body" strong>
            {record.name}@{record.version}
          </UITypographyText>
        ),
      },
      {
        title: 'Status',
        dataIndex: 'status',
        key: 'status',
        width: 140,
        render: (status: WorkflowRun['status']) => <WorkflowStatusBadge status={status} />,
      },
      {
        title: 'Triggered By',
        key: 'actor',
        width: 140,
        render: (_value: unknown, record: WorkflowRun) => (
          <UITypographyText className="typo-caption text-secondary">
            {record.trigger.actor ?? 'unknown'}
          </UITypographyText>
        ),
      },
      {
        title: 'Started At',
        dataIndex: 'startedAt',
        key: 'startedAt',
        width: 180,
        render: (val: string) => (
          <UITypographyText className="typo-caption">{formatDate(val)}</UITypographyText>
        ),
      },
      {
        title: 'Duration',
        key: 'duration',
        width: 100,
        render: (_value: unknown, record: WorkflowRun) => (
          <UITypographyText className="typo-caption">{formatDuration(record)}</UITypographyText>
        ),
      },
    ],
    [],
  );

  return (
    <UITable
      rowKey="id"
      columns={columns}
      dataSource={runs}
      loading={loading}
      scroll={{ x: 960 }}
      pagination={{ pageSize: 20 }}
      onRow={(record) => ({
        style: { cursor: 'pointer' },
        onClick: () => onRunClick(record.id),
      })}
    />
  );
}
