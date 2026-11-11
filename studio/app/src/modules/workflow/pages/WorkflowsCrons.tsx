/**
 * @module @kb-labs/studio-app/modules/workflows/pages/workflows-crons-page
 * Cron jobs list - standalone page
 */

import * as React from 'react';
import { useMutateData } from '@kb-labs/studio-hooks';
import { UITable, UITag, UISpace, UITypographyText, UIBadge, UIIcon, UIButton } from '@kb-labs/studio-ui-kit';
import { useData } from '@kb-labs/studio-hooks';
import { projectWorkflowEndpoint } from '@kb-labs/workflow-contracts/routes';
import { UICard } from '@kb-labs/studio-ui-kit';
import { UIPage, UIPageHeader } from '@kb-labs/studio-ui-kit';
import { useWorkflowProject } from '../components/shared/WorkflowProjectPicker';

export default function WorkflowsCrons() {
  const { projectId, picker, hasProjects } = useWorkflowProject();
  const { data: cronsData, isLoading, refetch } = useData<{ crons: Array<CronInfo> }>(projectWorkflowEndpoint(projectId, 'crons'), { enabled: hasProjects });

  const formatDate = (date?: Date | string) => {
    if (!date) {return '-';}
    return new Date(date).toLocaleString();
  };

  const columns = [
    {
      title: 'Cron ID',
      dataIndex: 'id',
      key: 'id',
      render: (id: string) => (
        <UITypographyText className="typo-body" strong>{id}</UITypographyText>
      ),
    },
    {
      title: 'Schedule',
      dataIndex: 'schedule',
      key: 'schedule',
      render: (schedule: string) => (
        <UISpace className="gap-tight">
          <UIIcon name="ClockCircleOutlined" className="text-secondary" />
          <UITypographyText className="typo-caption" code>{schedule}</UITypographyText>
        </UISpace>
      ),
    },
    {
      title: 'Target',
      dataIndex: 'target',
      key: 'target',
      render: (target: CronInfo['target']) => (
        <UITypographyText className="typo-body">{'workflow' in target ? target.workflow : target.handler}</UITypographyText>
      ),
    },
    {
      title: 'Timezone',
      dataIndex: 'timezone',
      key: 'timezone',
      render: (timezone?: string) => (
        <UITypographyText className="typo-caption">{timezone || 'UTC'}</UITypographyText>
      ),
    },
    {
      title: 'Status',
      dataIndex: 'enabled',
      key: 'enabled',
      render: (enabled: boolean) => (
        <UIBadge variant={enabled ? 'success' : 'default'}>
          {enabled ? 'Enabled' : 'Disabled'}
        </UIBadge>
      ),
    },
    {
      title: 'Last Run',
      dataIndex: 'lastRun',
      key: 'lastRun',
      render: (lastRun?: CronInfo['lastRun']) => (
        <UISpace className="gap-tight">
          <UIIcon name="CalendarOutlined" className="text-secondary" />
          <UITypographyText className="typo-caption">{lastRun ? `${lastRun.status} · ${formatDate(lastRun.time)}` : '-'}</UITypographyText>
        </UISpace>
      ),
    },
    {
      title: 'Next Run',
      dataIndex: 'nextFireAt',
      key: 'nextFireAt',
      render: (date?: string) => (
        date ? (
          <UISpace className="gap-tight">
            <UIIcon name="CalendarOutlined" className="text-info" />
            <UITypographyText className="typo-caption">{formatDate(date)}</UITypographyText>
          </UISpace>
        ) : (
          <UITypographyText className="typo-caption text-tertiary">-</UITypographyText>
        )
      ),
    },
    {
      title: 'Source',
      dataIndex: 'source',
      key: 'source',
      render: (source: CronInfo['source']) => (
        <UITag color={source === 'plugin' ? 'blue' : 'default'}>{source}</UITag>
      ),
    },
    {
      title: 'Action',
      key: 'action',
      render: (_: unknown, cron: CronInfo) => cron.source === 'user' ? (
        <CronToggle projectId={projectId} cron={cron} onSuccess={() => void refetch()} />
      ) : (
        <UITypographyText className="typo-caption text-tertiary">Read only</UITypographyText>
      ),
    },
  ];

  const enabledCount = cronsData?.crons?.filter((c) => c.enabled).length || 0;
  const disabledCount = cronsData?.crons?.filter((c) => !c.enabled).length || 0;

  return (
    <UIPage width="full">
      <UIPageHeader
        title="Workflow Crons"
        description="Project schedules for workflow automations"
        actions={picker}
        breadcrumbs={[
          { title: 'Home', href: '/' },
          { title: 'Workflows', href: '/workflows' },
          { title: 'Crons' },
        ]}
      />

      {/* Headline stats — compact single-row strip, not a stack of big cards */}
      <UICard styles={{ body: { padding: '18px 24px' } }} style={{ marginBottom: 'var(--spacing-section)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
          {[
            { label: 'Total Cron Jobs', value: cronsData?.crons?.length || 0 },
            { label: 'Enabled', value: enabledCount, valueColor: 'var(--success)' },
            { label: 'Disabled', value: disabledCount },
          ].map((metric, i) => (
            <div key={metric.label} style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
              {i > 0 && <span style={{ width: 1, alignSelf: 'stretch', background: 'var(--border-primary)' }} />}
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                <span style={{
                  fontSize: 20, fontWeight: 700, fontFamily: 'var(--font-heading)',
                  fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.01em',
                  color: metric.valueColor ?? 'var(--text-primary)',
                }}>
                  {metric.value}
                </span>
                <span style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>{metric.label}</span>
              </div>
            </div>
          ))}
        </div>
      </UICard>

      <UICard>
        <UITable
          dataSource={cronsData?.crons || []}
          columns={columns}
          loading={isLoading}
          rowKey="id"
          pagination={{ pageSize: 20 }}
        />
      </UICard>
    </UIPage>
  );
}

interface CronInfo {
  id: string;
  source: 'user' | 'plugin';
  schedule: string;
  timezone?: string;
  target: { workflow: string } | { handler: string };
  enabled: boolean;
  lastRun?: { id: string; status: string; time: string };
  nextFireAt?: string;
}

function CronToggle({ projectId, cron, onSuccess }: { projectId: string; cron: CronInfo; onSuccess: () => void }) {
  const action = cron.enabled ? 'disable' : 'enable';
  const mutation = useMutateData<void, void>(projectWorkflowEndpoint(projectId, `crons/${encodeURIComponent(cron.id)}/${action}`));
  return <UIButton size="small" loading={mutation.isLoading} onClick={() => {
    mutation.mutateAsync().then(onSuccess).catch(() => {});
  }}>{cron.enabled ? 'Disable' : 'Enable'}</UIButton>;
}
