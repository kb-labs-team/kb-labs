/**
 * @module @kb-labs/studio-app/modules/workflows/pages/workflows-runs-page
 * All workflow runs list — Triage / Board / Table views
 */

import { useMutateData } from '@kb-labs/studio-hooks';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  UIButton, UISelect, UIIcon, useUIMessage } from '@kb-labs/studio-ui-kit';
import { useData } from '@kb-labs/studio-hooks';
import type { WorkflowRun, WorkflowInfo } from '@kb-labs/workflow-contracts';
import { projectWorkflowEndpoint } from '@kb-labs/workflow-contracts/routes';
import { UIPage, UIPageHeader, UICard } from '@kb-labs/studio-ui-kit';
import { ViewModeSelector } from '../components/shared/ViewModeSelector';
import { TriageView } from '../components/triage/TriageView';
import { BoardView } from '../components/board/BoardView';
import { TableView } from '../components/table/TableView';
import { RunWorkflowModal } from '../components/RunWorkflowModal';
import { useWorkflowProject } from '../components/shared/WorkflowProjectPicker';

type ViewMode = 'triage' | 'board' | 'table';

const VIEWS = {
  triage: { label: 'Triage' },
  board:  { label: 'Board' },
  table:  { label: 'Table' },
};

export default function WorkflowsRuns() {
  const navigate = useNavigate();
  const [messageApi, contextHolder] = useUIMessage();
  const [viewMode, setViewMode] = useState<ViewMode>('triage');
  const [filters, setFilters] = useState<{ limit: number; status?: string }>({ limit: 50 });
  const [runModalOpen, setRunModalOpen] = useState(false);
  const { projectId, picker, hasProjects } = useWorkflowProject();

  const { data, isLoading, refetch } = useData<{ runs: WorkflowRun[]; total: number }>(projectWorkflowEndpoint(projectId, 'runs'), {
    params: { limit: filters.limit, ...(filters.status ? { status: filters.status } : {}) },
    enabled: hasProjects,
    pollingMs: viewMode !== 'table' ? 5000 : undefined,
  });
  const { data: workflowsData } = useData<{ workflows: WorkflowInfo[] }>(projectWorkflowEndpoint(projectId, 'workflows'), { params: { limit: 100 }, enabled: hasProjects });

  const runWorkflowMutation = useMutateData<
    { workflowId: string; input: Record<string, unknown> },
    { runId: string; status: string }
  >(
    (p) => projectWorkflowEndpoint(projectId, `workflows/${encodeURIComponent(p.workflowId)}/runs`),
    { mapBody: (p) => ({ inputs: p.input }) },
  );

  const runs = data?.runs ?? [];

  return (
    <UIPage width="full">
      {contextHolder}
      <UIPageHeader
        title="Workflow Runs"
        description={hasProjects ? 'Workflow executions for the selected project' : 'Register a project to view workflow executions'}
        breadcrumbs={[
          { title: 'Home', href: '/' },
          { title: 'Workflows', href: '/workflows' },
          { title: 'Runs' },
        ]}
        actions={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <ViewModeSelector views={VIEWS} current={viewMode} onChange={setViewMode} />
            {picker}
            <UIButton
              icon={<UIIcon name="ReloadOutlined" spin={isLoading} />}
              onClick={() => refetch()}
            />
            <UIButton
              variant="primary"
              icon={<UIIcon name="PlayCircleOutlined" />}
              onClick={() => setRunModalOpen(true)}
            >
              Run Workflow
            </UIButton>
          </div>
        }
      />

      {/* Toolbar — one row, no labels, placeholders do the talking */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 'var(--spacing-section)' }}>
        <UISelect
          style={{ width: 160 }}
          placeholder="All statuses"
          allowClear
          value={filters.status}
          onChange={(status) => setFilters({ ...filters, status: status as string | undefined })}
          options={[
            { label: 'Running', value: 'running' },
            { label: 'Success', value: 'success' },
            { label: 'Failed', value: 'failed' },
            { label: 'Dead Letter', value: 'dlq' },
            { label: 'Cancelled', value: 'cancelled' },
            { label: 'Queued', value: 'queued' },
          ]}
        />
        <UISelect
          style={{ width: 100 }}
          value={filters.limit}
          onChange={(limit) => setFilters({ ...filters, limit: limit as number })}
          options={[
            { label: '25', value: 25 },
            { label: '50', value: 50 },
            { label: '100', value: 100 },
            { label: '200', value: 200 },
          ]}
        />
      </div>

      {/* View */}
      {viewMode === 'triage' && (
        <TriageView runs={runs} onRunClick={(id) => navigate(`/p/workflows/runs/${id}`)} />
      )}
      {viewMode === 'board' && (
        <BoardView runs={runs} onRunClick={(id) => navigate(`/p/workflows/runs/${id}`)} />
      )}
      {viewMode === 'table' && (
        <UICard>
          <TableView runs={runs} loading={isLoading} onRunClick={(id) => navigate(`/p/workflows/runs/${id}`)} />
        </UICard>
      )}

      <RunWorkflowModal
        open={runModalOpen}
        workflows={workflowsData?.workflows ?? []}
        loading={runWorkflowMutation.isLoading}
        onClose={() => setRunModalOpen(false)}
        onRun={(workflowId, input) => {
          runWorkflowMutation.mutate({ workflowId, input }, {
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
