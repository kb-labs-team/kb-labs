/**
 * @module @kb-labs/studio-app/modules/workflows/pages/workflows-definitions-page
 * Workflow definitions list - standalone page
 */

import * as React from 'react';
import { useMutateData } from '@kb-labs/studio-hooks';
import { useNavigate } from 'react-router-dom';
import {
  UITable, UITag, UISpace, UITypographyText, UIButton, UIIcon, useUIMessage } from '@kb-labs/studio-ui-kit';
import { useData } from '@kb-labs/studio-hooks';
import type { WorkflowInfo } from '@kb-labs/workflow-contracts';
import { projectWorkflowEndpoint } from '@kb-labs/workflow-contracts/routes';
import { UICard } from '@kb-labs/studio-ui-kit';
import { RunWorkflowModal } from '../components/RunWorkflowModal';
import { UIPage, UIPageHeader } from '@kb-labs/studio-ui-kit';
import { useWorkflowProject } from '../components/shared/WorkflowProjectPicker';

export default function WorkflowsDefinitions() {
  const navigate = useNavigate();
  const [messageApi, contextHolder] = useUIMessage();
  const [runModalWorkflow, setRunModalWorkflow] = React.useState<WorkflowInfo | null>(null);
  const { projectId, picker, hasProjects } = useWorkflowProject();

  const { data: workflowsData, isLoading } = useData<{ workflows: WorkflowInfo[] }>(projectWorkflowEndpoint(projectId, 'workflows'), {
    params: { limit: 100 },
    enabled: hasProjects,
  });

  const runWorkflowMutation = useMutateData<
    { workflowId: string; input: Record<string, unknown> },
    { runId: string; status: string }
  >(
    (p) => projectWorkflowEndpoint(projectId, `workflows/${encodeURIComponent(p.workflowId)}/runs`),
    { mapBody: (p) => ({ inputs: p.input }) },
  );

  const columns = [
    {
      title: 'Workflow',
      dataIndex: 'name',
      key: 'name',
      width: 280,
      render: (name: string, record: WorkflowInfo) => (
        <div style={{ width: '100%', overflow: 'hidden' }}>
          <UITypographyText className="typo-body" strong style={{ display: 'block' }}>{name}</UITypographyText>
          {record.description && (
            <UITypographyText
              className="typo-description text-secondary"
              ellipsis={{ tooltip: record.description }}
              style={{ display: 'block' }}
            >
              {record.description}
            </UITypographyText>
          )}
        </div>
      ),
    },
    {
      title: 'ID',
      dataIndex: 'id',
      key: 'id',
      width: 220,
      render: (id: string) => (
        <UITypographyText className="typo-caption text-tertiary" code ellipsis={{ tooltip: id }}>{id}</UITypographyText>
      ),
    },
    {
      title: 'Source',
      dataIndex: 'source',
      key: 'source',
      width: 120,
      render: (source: 'manifest' | 'standalone') => (
        <UITag color={source === 'manifest' ? 'blue' : 'green'}>
          {source === 'manifest' ? 'Plugin' : 'Standalone'}
        </UITag>
      ),
    },
    {
      title: 'Plugin',
      dataIndex: 'pluginId',
      key: 'pluginId',
      width: 200,
      render: (pluginId?: string) => (
        pluginId ? (
          <UITypographyText className="typo-caption">{pluginId}</UITypographyText>
        ) : (
          <UITypographyText className="typo-caption text-tertiary">-</UITypographyText>
        )
      ),
    },
    {
      title: 'Version',
      dataIndex: 'version',
      key: 'version',
      width: 100,
      render: (version?: string, record?: WorkflowInfo) => {
        if (!version) {return <UITypographyText className="typo-caption text-tertiary">-</UITypographyText>;}
        const tooltip = record?.updatedAt
          ? `Updated ${new Date(record.updatedAt).toLocaleString()}`
          : undefined;
        return (
          <UITypographyText className="typo-caption" code title={tooltip}>
            v{version}
          </UITypographyText>
        );
      },
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (status?: 'active' | 'inactive') => {
        if (!status) {return <UITypographyText className="typo-caption text-tertiary">-</UITypographyText>;}
        return (
          <UITag color={status === 'active' ? 'success' : 'default'}>
            {status.toUpperCase()}
          </UITag>
        );
      },
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 160,
      fixed: 'right' as const,
      render: (_: unknown, record: WorkflowInfo) => (
        <UISpace className="gap-tight">
          <UIButton
            variant="link"
            size="small"
            icon={<UIIcon name="EyeOutlined" />}
            onClick={(e) => {
              e.stopPropagation();
              navigate(`/p/workflows/definitions/${encodeURIComponent(record.id)}`);
            }}
          >
            View
          </UIButton>
          <UIButton
            variant="link"
            size="small"
            icon={<UIIcon name="PlayCircleOutlined" />}
            onClick={(e) => {
              e.stopPropagation();
              setRunModalWorkflow(record);
            }}
          >
            Run
          </UIButton>
        </UISpace>
      ),
    },
  ];

  return (
    <UIPage width="full">
      {contextHolder}
      <UIPageHeader
        title="Workflow Definitions"
        description="All registered workflow definitions"
        breadcrumbs={[
          { title: 'Home', href: '/' },
          { title: 'Workflows', href: '/workflows' },
          { title: 'Definitions' },
        ]}
        actions={picker}
      />

      <UICard>
        <UITable
          dataSource={workflowsData?.workflows || []}
          columns={columns}
          loading={isLoading}
          rowKey="id"
          scroll={{ x: 1210 }}
          pagination={{ pageSize: 20 }}
          onRow={(record: WorkflowInfo) => ({
            style: { cursor: 'pointer' },
            onClick: () => navigate(`/p/workflows/definitions/${encodeURIComponent(record.id)}`),
          })}
        />
      </UICard>

      <RunWorkflowModal
        open={!!runModalWorkflow}
        workflow={runModalWorkflow}
        loading={runWorkflowMutation.isLoading}
        onClose={() => setRunModalWorkflow(null)}
        onRun={(workflowId, input) => {
          runWorkflowMutation.mutate({ workflowId, input }, {
            onSuccess: (data) => {
              setRunModalWorkflow(null);
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
