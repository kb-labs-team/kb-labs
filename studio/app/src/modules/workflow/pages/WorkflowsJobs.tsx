/**
 * @module @kb-labs/studio-app/modules/workflows/pages/workflows-jobs-page
 * Background jobs list - standalone page
 */

import * as React from 'react';
import { UITable, UITag, UISpace, UITypographyText, UISelect } from '@kb-labs/studio-ui-kit';
import { useData } from '@kb-labs/studio-hooks';
import type { JobStatusInfo, JobListFilter } from '@kb-labs/workflow-contracts';
import { projectWorkflowEndpoint } from '@kb-labs/workflow-contracts/routes';
import { UICard } from '@kb-labs/studio-ui-kit';
import { UIPage, UIPageHeader } from '@kb-labs/studio-ui-kit';
import { useWorkflowProject } from '../components/shared/WorkflowProjectPicker';

const STATUS_COLORS: Record<string, string> = {
  queued: 'default',
  running: 'processing',
  success: 'success',
  failed: 'error',
  cancelled: 'warning',
  skipped: 'default',
  dlq: 'error',
};

export default function WorkflowsJobs() {
  const [filters, setFilters] = React.useState<JobListFilter>({ limit: 50 });
  const { projectId, picker, hasProjects } = useWorkflowProject();

  const { data: jobsData, isLoading } = useData<{ jobs: JobStatusInfo[] }>(projectWorkflowEndpoint(projectId, 'jobs'), {
    params: filters as Record<string, string | number | boolean>,
    enabled: hasProjects,
  });

  const formatDate = (date?: Date | string) => {
    if (!date) {return '-';}
    return new Date(date).toLocaleString();
  };

  const formatDuration = (start?: Date | string, end?: Date | string) => {
    if (!start) {return '-';}
    const startMs = new Date(start).getTime();
    const endMs = end ? new Date(end).getTime() : Date.now();
    const durationMs = endMs - startMs;
    const seconds = Math.floor(durationMs / 1000);
    if (seconds < 60) {return `${seconds}s`;}
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {return `${minutes}m ${seconds % 60}s`;}
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  };

  const columns = [
    {
      title: 'Job ID',
      dataIndex: 'id',
      key: 'id',
      width: 180,
      render: (id: string) => (
        <UITypographyText className="typo-caption" code ellipsis={{ tooltip: id }} style={{ whiteSpace: 'nowrap' }}>{id.slice(0, 16)}...</UITypographyText>
      ),
    },
    {
      title: 'Type',
      dataIndex: 'type',
      key: 'type',
      width: 260,
      render: (type: string) => (
        <UITypographyText className="typo-body" ellipsis={{ tooltip: type }} style={{ display: 'block' }}>{type}</UITypographyText>
      ),
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 130,
      render: (status: string, record: JobStatusInfo) => (
        <UISpace direction="vertical" className="gap-tight">
          <UITag color={STATUS_COLORS[status] || 'default'}>
            {status.toUpperCase()}
          </UITag>
          {record.progress !== undefined && status === 'running' && (
            <UITypographyText className="typo-caption text-secondary">
              {record.progress}%{record.progressMessage && ` · ${record.progressMessage}`}
            </UITypographyText>
          )}
        </UISpace>
      ),
    },
    {
      title: 'Created',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 220,
      render: (date: Date | string | undefined) => (
        <UITypographyText className="typo-caption" style={{ whiteSpace: 'nowrap' }}>{formatDate(date)}</UITypographyText>
      ),
    },
    {
      title: 'Duration',
      key: 'duration',
      width: 100,
      render: (_: unknown, record: JobStatusInfo) => (
        <UITypographyText className="typo-caption">
          {formatDuration(record.startedAt, record.finishedAt)}
        </UITypographyText>
      ),
    },
    {
      title: 'Attempts',
      key: 'attempts',
      width: 90,
      render: (_: unknown, record: JobStatusInfo) => (
        <UITypographyText className="typo-caption">
          {record.attempt || 0} / {record.maxRetries || 3}
        </UITypographyText>
      ),
    },
    {
      title: 'Error',
      dataIndex: 'error',
      key: 'error',
      width: 260,
      render: (error?: string) => (
        error ? (
          <UITypographyText className="typo-caption text-error" ellipsis={{ tooltip: error }} style={{ display: 'block' }}>
            {error}
          </UITypographyText>
        ) : (
          <UITypographyText className="typo-caption text-tertiary">-</UITypographyText>
        )
      ),
    },
  ];

  return (
    <UIPage width="full">
      <UIPageHeader
        title="Background Jobs"
        description="Monitor background job execution and status"
        actions={picker}
        breadcrumbs={[
          { title: 'Home', href: '/' },
          { title: 'Workflows', href: '/workflows' },
          { title: 'Jobs' },
        ]}
      />

      {/* Toolbar — one row, no labels, placeholders do the talking */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 'var(--spacing-section)' }}>
        <UISelect
          style={{ width: 160 }}
          placeholder="All statuses"
          allowClear
          value={filters.status}
          onChange={(status) => setFilters({ ...filters, status: status as typeof filters.status })}
          options={[
            { label: 'Queued', value: 'queued' },
            { label: 'Running', value: 'running' },
            { label: 'Success', value: 'success' },
            { label: 'Failed', value: 'failed' },
            { label: 'Cancelled', value: 'cancelled' },
            { label: 'Skipped', value: 'skipped' },
            { label: 'Dead letter', value: 'dlq' },
          ]}
        />
        <UISelect
          style={{ width: 180 }}
          placeholder="All types"
          allowClear
          showSearch
          value={filters.type}
          onChange={(type) => setFilters({ ...filters, type: type as string | undefined })}
          options={[]}
        />
        <UISelect
          style={{ width: 100 }}
          value={filters.limit || 50}
          onChange={(limit) => setFilters({ ...filters, limit: limit as number })}
          options={[
            { label: '25', value: 25 },
            { label: '50', value: 50 },
            { label: '100', value: 100 },
            { label: '200', value: 200 },
          ]}
        />
      </div>

      <UICard>
        <UITable
          dataSource={jobsData?.jobs || []}
          columns={columns}
          loading={isLoading}
          rowKey="id"
          scroll={{ x: 1240 }}
          pagination={{ pageSize: 20 }}
        />
      </UICard>
    </UIPage>
  );
}
