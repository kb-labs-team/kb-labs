/**
 * @module @kb-labs/studio-app/modules/workflows/pages/workflow-definition-page
 * Workflow definition detail page with recent runs
 */

import * as React from 'react';
import { useMutateData } from '@kb-labs/studio-hooks';
import { useParams, useNavigate } from 'react-router-dom';
import {
  UISkeleton, UITag, UISpace, UITypographyText, UICard, UITable, UIButton, UIIcon, UIEmptyState, useUIMessage } from '@kb-labs/studio-ui-kit';
import { useData } from '@kb-labs/studio-hooks';
import { UIPage, UIPageHeader } from '@kb-labs/studio-ui-kit';
import type { WorkflowRunInfo, WorkflowInfo } from '@kb-labs/workflow-contracts';
import { projectWorkflowEndpoint } from '@kb-labs/workflow-contracts/routes';
import { RunWorkflowModal } from '../components/RunWorkflowModal';
import { useWorkflowProject } from '../components/shared/WorkflowProjectPicker';

const STATUS_COLORS: Record<string, string> = {
  queued: 'default',
  running: 'processing',
  success: 'success',
  failed: 'error',
  cancelled: 'warning',
  skipped: 'default',
  waiting_approval: 'gold',
};

function formatDate(dateStr?: string) {
  if (!dateStr) {return '-';}
  return new Date(dateStr).toLocaleString();
}

function formatDuration(ms?: number) {
  if (!ms) {return '-';}
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) {return `${seconds}s`;}
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {return `${minutes}m ${seconds % 60}s`;}
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function CancelRunButton({ projectId, runId, onSuccess }: { projectId: string; runId: string; onSuccess: () => void }) {
  const cancel = useMutateData<void, void>(projectWorkflowEndpoint(projectId, `runs/${encodeURIComponent(runId)}/cancel`));
  return (
    <UIButton
      variant="link"
      size="small"
      danger
      icon={<UIIcon name="StopOutlined" />}
      loading={cancel.isLoading}
      onClick={(e) => {
        e.stopPropagation();
        cancel.mutateAsync().then(onSuccess).catch(() => {});
      }}
    >
      Cancel
    </UIButton>
  );
}

export default function WorkflowDefinitionDetail() {
  const { workflowId: encodedId } = useParams<{ workflowId: string }>();
  const navigate = useNavigate();
  const [messageApi, contextHolder] = useUIMessage();

  const workflowId = encodedId ? decodeURIComponent(encodedId) : '';
  const [runModalOpen, setRunModalOpen] = React.useState(false);
  const { projectId, picker, hasProjects } = useWorkflowProject();

  const { data: workflowDef, isLoading: workflowLoading } = useData<WorkflowInfo>(
    projectWorkflowEndpoint(projectId, workflowId ? `workflows/${encodeURIComponent(workflowId)}` : 'workflows/__none__'),
    { enabled: !!workflowId && hasProjects },
  );

  const { data: runsData, isLoading: runsLoading, refetch } = useData<{ runs: WorkflowRunInfo[] }>(
    projectWorkflowEndpoint(projectId, workflowId ? `workflows/${encodeURIComponent(workflowId)}/runs` : 'workflows/__none__/runs'),
    { enabled: !!workflowId && hasProjects, pollingMs: 5000, params: { limit: 50 } },
  );

  const runWorkflowMutation = useMutateData<Record<string, unknown>, { runId: string }>(
    projectWorkflowEndpoint(projectId, `workflows/${encodeURIComponent(workflowId)}/runs`),
  );

  const runsColumns = [
    {
      title: 'Run ID',
      dataIndex: 'id',
      key: 'id',
      width: 200,
      render: (id: string) => (
        <UITypographyText
          className="typo-caption"
          code
          ellipsis={{ tooltip: id }}
          style={{ cursor: 'pointer', color: 'var(--color-link)' }}
          onClick={(e: React.MouseEvent) => {
            e.stopPropagation();
            navigate(`/p/workflows/runs/${id}`);
          }}
        >
          {id.slice(0, 16)}...
        </UITypographyText>
      ),
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 140,
      render: (status: string) => (
        <UITag color={STATUS_COLORS[status] ?? 'default'}>{status.toUpperCase()}</UITag>
      ),
    },
    {
      title: 'Triggered By',
      dataIndex: 'trigger',
      key: 'user',
      width: 160,
      render: (trigger?: { user?: string }) => (
        <UITypographyText className="typo-caption text-secondary">{trigger?.user ?? '-'}</UITypographyText>
      ),
    },
    {
      title: 'Started At',
      dataIndex: 'startedAt',
      key: 'startedAt',
      width: 180,
      render: (date?: string) => (
        <UITypographyText className="typo-caption">{formatDate(date)}</UITypographyText>
      ),
    },
    {
      title: 'Duration',
      dataIndex: 'durationMs',
      key: 'durationMs',
      width: 100,
      render: (ms?: number) => (
        <UITypographyText className="typo-caption">{formatDuration(ms)}</UITypographyText>
      ),
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 100,
      fixed: 'right' as const,
      render: (_: unknown, record: WorkflowRunInfo) => {
        const canCancel = record.status === 'running' || record.status === 'queued';
        if (!canCancel) {return null;}
        return <CancelRunButton projectId={projectId} runId={record.id} onSuccess={() => void refetch()} />;
      },
    },
  ];

  if (workflowLoading) {
    return (
      <UIPage>
        <UISkeleton active avatar lines={6} />
      </UIPage>
    );
  }

  if (!workflowDef) {
    return (
      <UIPage>
        <UIEmptyState
          description={`Workflow "${workflowId}" not found`}
          action={
            <UIButton onClick={() => navigate('/p/workflows/definitions')}>Back to Definitions</UIButton>
          }
        />
      </UIPage>
    );
  }

  return (
    <UIPage>
      {contextHolder}
      <UIPageHeader
        title={workflowDef.name}
        description={workflowDef.description}
        breadcrumbs={[
          { title: 'Home', href: '/' },
          { title: 'Workflows', href: '/workflows' },
          { title: 'Definitions', href: '/p/workflows/definitions' },
          { title: workflowDef.name },
        ]}
        actions={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {picker}
          <UIButton
            variant="primary"
            icon={<UIIcon name="PlayCircleOutlined" />}
            onClick={() => setRunModalOpen(true)}
          >
            Run
          </UIButton>
          </div>
        }
      />

      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '8px 16px',
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-primary)',
        borderRadius: 8,
        flexWrap: 'wrap',
        marginBottom: 'var(--spacing-section)',
      }}>
        {workflowDef.status && (
          <UITag color={workflowDef.status === 'active' ? 'success' : 'default'}>
            {workflowDef.status.toUpperCase()}
          </UITag>
        )}
        <UITypographyText code className="typo-caption">{workflowDef.id}</UITypographyText>
        <UITag color={workflowDef.source === 'manifest' ? 'blue' : 'green'}>
          {workflowDef.source === 'manifest' ? 'Plugin' : 'Standalone'}
        </UITag>
        {workflowDef.pluginId && (
          <UITypographyText className="typo-caption text-tertiary">{workflowDef.pluginId}</UITypographyText>
        )}
        {workflowDef.tags && workflowDef.tags.length > 0 && (
          <>
            <span style={{ width: 1, alignSelf: 'stretch', background: 'var(--border-primary)' }} />
            <UISpace className="gap-tight">
              {workflowDef.tags.map((tag) => (
                <UITag key={tag}>{tag}</UITag>
              ))}
            </UISpace>
          </>
        )}
      </div>

      <UICard
        title={
          <UITypographyText className="typo-card-title">Recent Runs</UITypographyText>
        }
      >
        <UITable
          dataSource={runsData?.runs ?? []}
          columns={runsColumns}
          loading={runsLoading}
          rowKey="id"
          scroll={{ x: 900 }}
          pagination={{ pageSize: 20 }}
          onRow={(record: WorkflowRunInfo) => ({
            style: { cursor: 'pointer' },
            onClick: () => navigate(`/p/workflows/runs/${record.id}`),
          })}
        />
      </UICard>

      <RunWorkflowModal
        open={runModalOpen}
        workflow={workflowDef}
        loading={runWorkflowMutation.isLoading}
        onClose={() => setRunModalOpen(false)}
        onRun={(_workflowId, input) => {
          runWorkflowMutation.mutate(input, {
            onSuccess: (data) => {
              setRunModalOpen(false);
              navigate(`/p/workflows/runs/${data.runId}`);
            },
            onError: (err) => {
              messageApi.error(`Failed to start workflow "${workflowId}": ${err.message}`);
            },
          });
        }}
      />
    </UIPage>
  );
}
