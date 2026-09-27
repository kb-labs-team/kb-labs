/**
 * @module @kb-labs/studio-app/modules/health/pages/health-page
 *
 * Health/status screen (stage 6, final slice, closing "the remaining items:
 * health/doctor screen, 'Update' button" of the target-architecture migration).
 * Studio only calls the host's `/api/v1/health` and `/api/v1/update` APIs — it
 * never talks to the launcher's control channel directly (ADR-0045).
 */

import * as React from 'react';
import {
  UIButton,
  UICard,
  UIIcon,
  UIList,
  UIListItem,
  UIMessage,
  UIPage,
  UIPageHeader,
  UISpin,
  UITag,
  UIText,
} from '@kb-labs/studio-ui-kit';
import { useDataSources } from '@/providers/data-sources-provider';
import { useHealth, type HealthCheck, type HealthSection } from '@kb-labs/studio-data-client';
import { UpdateModal } from '../components/update-modal';

function CheckTag({ check }: { check: HealthCheck }) {
  return <UITag variant={check.ok ? 'success' : 'error'}>{check.ok ? 'OK' : 'Issue'}</UITag>;
}

function SectionCard({
  title,
  description,
  section,
}: {
  title: string;
  description: string;
  section: HealthSection;
}) {
  return (
    <UICard
      title={title}
      subtitle={description}
      status={section.ok ? 'success' : 'error'}
      style={{ marginBottom: 16 }}
    >
      <UIList<HealthCheck>
        dataSource={section.checks}
        rowKey="id"
        renderItem={(check) => (
          <UIListItem key={check.id}>
            <div style={{ display: 'flex', width: '100%', gap: 12, alignItems: 'flex-start' }}>
              <CheckTag check={check} />
              <div style={{ flex: 1 }}>
                <UIText weight="semibold">{check.id}</UIText>
                {check.detail && (
                  <div style={{ opacity: 0.75, fontSize: 13 }}>{check.detail}</div>
                )}
                {!check.ok && check.hint && (
                  <div style={{ fontSize: 13, marginTop: 2 }}>Hint: {check.hint}</div>
                )}
              </div>
            </div>
          </UIListItem>
        )}
      />
    </UICard>
  );
}

export function HealthPage() {
  const { health: healthSource } = useDataSources();
  const { data: report, isLoading, isError, error, refetch } = useHealth(healthSource);
  const [updateOpen, setUpdateOpen] = React.useState(false);

  if (isLoading) {
    return (
      <UIPage>
        <UIPageHeader title="Health" description="Installation and platform status." />
        <UISpin />
      </UIPage>
    );
  }

  if (isError || !report) {
    return (
      <UIPage>
        <UIPageHeader title="Health" description="Installation and platform status." />
        <UICard status="error" title="The launcher control channel is unavailable">
          <UIText>
            {error instanceof Error
              ? error.message
              : 'The host could not reach the launcher (kb-create). Run "kb-create start" and reload.'}
          </UIText>
          <div style={{ marginTop: 12 }}>
            <UIButton onClick={() => void refetch()}>Retry</UIButton>
          </div>
        </UICard>
      </UIPage>
    );
  }

  return (
    <UIPage>
      <UIPageHeader
        title="Health"
        description="Installation and platform status, reported by the launcher's control channel."
        actions={
          <>
            <UITag variant={report.ok ? 'success' : 'error'} style={{ marginRight: 12 }}>
              {report.ok ? 'Healthy' : 'Attention needed'}
            </UITag>
            <UIButton
              variant="primary"
              icon={<UIIcon name="CloudUploadOutlined" />}
              onClick={() => setUpdateOpen(true)}
            >
              Update
            </UIButton>
          </>
        }
      />
      <SectionCard
        title="Installation"
        description="What the launcher put on disk (receipt, generated config, host binary, launcher state)."
        section={report.installation}
      />
      <SectionCard
        title="Platform"
        description="The running host and what it serves (process, upstreams, adapters, sign-in)."
        section={report.platform}
      />
      <UpdateModal
        open={updateOpen}
        onClose={() => setUpdateOpen(false)}
        onQueued={() => {
          setUpdateOpen(false);
          UIMessage.info('The launcher will restart the host once the update is applied.');
          void refetch();
        }}
      />
    </UIPage>
  );
}
