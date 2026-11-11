/**
 * Overview tab — operational snapshot for the selected scope: current
 * version, unreleased changes, last release health, and per-channel status.
 * The default landing view; the release wizard and history are one click
 * away via the quick actions below.
 */

import * as React from 'react';
import {
  UIRow,
  UICol,
  UICard,
  UIMetricCard,
  UIBadge,
  UITag,
  UIAlert,
  UIButton,
  UISpace,
  UIEmptyState,
  UISpin,
  UITypographyText,
} from '@kb-labs/sdk/studio';
import { useData } from '@kb-labs/sdk/studio';
import type {
  StatusResponse,
  GitTimelineResponse,
  HistoryResponse,
  ReleaseScopeInfo,
  ReleaseHistoryItem,
} from '../../contracts/index.js';

const UNSPECIFIED_CHANNEL = 'unspecified';

interface OverviewTabProps {
  scope: ReleaseScopeInfo | undefined;
  selectedScope: string;
  onStartRelease: () => void;
  onViewHistory: () => void;
}

function formatRelativeDate(dateStr?: string): string {
  if (!dateStr) { return 'Never'; }
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) { return 'Just now'; }
  if (diffMins < 60) { return `${diffMins}m ago`; }
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) { return `${diffHours}h ago`; }
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

/** Latest history entry per channel, grouping releases that predate the
 * channel field under a neutral "unspecified" bucket instead of guessing. */
function groupLatestByChannel(releases: ReleaseHistoryItem[]): Array<[string, ReleaseHistoryItem]> {
  const latest = new Map<string, ReleaseHistoryItem>();
  for (const release of releases) {
    const key = release.channel ?? UNSPECIFIED_CHANNEL;
    const existing = latest.get(key);
    if (!existing || new Date(release.timestamp) > new Date(existing.timestamp)) {
      latest.set(key, release);
    }
  }
  return Array.from(latest.entries());
}

export function OverviewTab({ scope, selectedScope, onStartRelease, onViewHistory }: OverviewTabProps) {
  const statusUrl = selectedScope ? `/v1/plugins/release/status?scope=${encodeURIComponent(selectedScope)}` : '';
  const timelineUrl = selectedScope ? `/v1/plugins/release/git-timeline?scope=${encodeURIComponent(selectedScope)}` : '';
  const historyUrl = selectedScope ? `/v1/plugins/release/history?scope=${encodeURIComponent(selectedScope)}` : '';

  const { data: statusData, isLoading: statusLoading } = useData<StatusResponse>(statusUrl);
  const { data: timelineData, isLoading: timelineLoading } = useData<GitTimelineResponse>(timelineUrl);
  const { data: historyData, isLoading: historyLoading } = useData<HistoryResponse>(historyUrl);

  if (!selectedScope) {
    return (
      <UICard>
        <UIEmptyState
          description="Select a scope to see its release status"
          image={UIEmptyState.PRESENTED_IMAGE_SIMPLE}
        />
      </UICard>
    );
  }

  if (statusLoading || timelineLoading || historyLoading) {
    return <UISpin size="large" style={{ display: 'block', margin: '48px auto' }} />;
  }

  const releases = historyData?.releases ?? [];
  const lastRelease = releases[0]; // history-handler already sorts newest first
  const hasInProgress = !!statusData?.hasPlan && statusData.planStatus === 'ready';
  const channelEntries = groupLatestByChannel(releases);
  const suggestedBump = timelineData?.suggestedBump && timelineData.suggestedBump !== 'none'
    ? timelineData.suggestedBump
    : undefined;

  return (
    <div>
      {hasInProgress && (
        <UIAlert
          variant="info"
          message="Release in progress for this scope"
          description="A plan has already been generated but not yet published."
          action={<UIButton size="small" onClick={onStartRelease}>Continue</UIButton>}
          showIcon
          style={{ marginBottom: 16 }}
        />
      )}

      <UIRow gutter={16} style={{ marginBottom: 16 }}>
        <UICol span={6}>
          <UIMetricCard label="Current Version" value={scope?.currentVersion ?? '—'} />
        </UICol>
        <UICol span={6}>
          <UIMetricCard
            label="Unreleased Changes"
            value={timelineData?.unreleased ?? 0}
            status={timelineData?.hasUnreleasedChanges ? 'warning' : 'success'}
          />
        </UICol>
        <UICol span={6}>
          <UIMetricCard
            label="Last Release"
            value={formatRelativeDate(lastRelease?.timestamp)}
            status={lastRelease ? (lastRelease.success ? 'success' : 'error') : 'default'}
          />
        </UICol>
        <UICol span={6}>
          <UIMetricCard label="Suggested Bump" value={suggestedBump ?? '—'} status="info" />
        </UICol>
      </UIRow>

      <UITypographyText type="secondary" style={{ display: 'block', marginBottom: 8, fontSize: 12 }}>
        Channels
      </UITypographyText>
      {channelEntries.length === 0 ? (
        <UICard size="small" style={{ marginBottom: 16 }}>
          <UIEmptyState
            description="No releases yet for this scope"
            image={UIEmptyState.PRESENTED_IMAGE_SIMPLE}
          />
        </UICard>
      ) : (
        <UIRow gutter={16} style={{ marginBottom: 16 }}>
          {channelEntries.map(([channel, release]) => (
            <UICol span={8} key={channel}>
              <UICard size="small" status={release.success ? 'success' : 'error'}>
                <UITag>{channel}</UITag>
                <div style={{ marginTop: 8 }}>
                  <UITypographyText strong>{release.version ?? '—'}</UITypographyText>
                </div>
                <div style={{ marginTop: 4 }}>
                  <UIBadge variant={release.success ? 'success' : 'error'}>
                    {release.success ? 'Success' : 'Failed'}
                  </UIBadge>
                  <UITypographyText type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                    {formatRelativeDate(release.timestamp)}
                  </UITypographyText>
                </div>
              </UICard>
            </UICol>
          ))}
        </UIRow>
      )}

      <UISpace>
        <UIButton variant="primary" onClick={onStartRelease}>Start New Release</UIButton>
        <UIButton onClick={onViewHistory}>View History</UIButton>
      </UISpace>
    </div>
  );
}
