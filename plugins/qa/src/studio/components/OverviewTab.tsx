import * as React from 'react';
import {
  UITag, UIAlert,
  UISkeleton, UISpace, UIIcon,
  useData, useTheme,
} from '@kb-labs/sdk/studio';
import { CheckDetailDrawer } from './CheckDetailDrawer';
import { BaselineDiffCard } from './BaselineDiffCard';
import { ErrorGroupsPanel } from './ErrorGroupsPanel';
import type { RunSnapshot, StatsSnapshot, BaselineData } from '../../contracts/index.js';
import { QA_BASE_PATH, QA_ROUTES } from '../../contracts/index.js';

type SummaryResponse = {
  latestRun: RunSnapshot | null;
  latestCheck: import('../../contracts/index.js').CheckSnapshot | null;
  latestStats: StatsSnapshot | null;
  baseline: BaselineData | null;
};

export function OverviewTab() {
  const { antdToken: token } = useTheme();

  const { data: summary, isLoading } = useData<SummaryResponse>(
    `${QA_BASE_PATH}${QA_ROUTES.SUMMARY}`,
  );

  const [drawerOpen, setDrawerOpen] = React.useState(false);

  if (isLoading) {
    return <UISkeleton active lines={6} />;
  }

  if (!summary) {
    return (
      <UIAlert
        variant="info"
        showIcon
        message="No QA data"
        description="Run 'kb qa run' to generate QA history."
        style={{ marginBottom: token.marginLG }}
      />
    );
  }

  const { latestRun, latestStats } = summary;

  const stats = latestStats?.raw;
  const run = latestRun?.raw;

  // Group run results by task
  const taskGroups = new Map<string, { passed: number; failed: number; cached: number }>();
  if (run?.results) {
    for (const r of run.results) {
      const existing = taskGroups.get(r.Task) ?? { passed: 0, failed: 0, cached: 0 };
      if (r.Cached) { existing.cached += 1; }
      else if (r.OK) { existing.passed += 1; }
      else { existing.failed += 1; }
      taskGroups.set(r.Task, existing);
    }
  }

  const overallOk = run?.ok ?? null;
  const grade = stats?.grade ?? null;
  const score = stats?.score ?? null;

  return (
    <div>
      {/* Status Banner */}
      <UIAlert
        variant={overallOk === true ? 'success' : overallOk === false ? 'error' : 'info'}
        showIcon
        icon={overallOk === true
          ? <UIIcon name="CheckCircleOutlined" />
          : <UIIcon name="CloseCircleOutlined" />}
        message={
          <UISpace>
            <span style={{ fontWeight: 600 }}>
              QA Status: {overallOk === true ? 'Passing' : overallOk === false ? 'Failing' : 'No data'}
            </span>
            {grade && (
              <UITag color={grade.startsWith('A') ? 'success' : grade === 'B' ? 'warning' : 'error'}>
                Grade: {grade}
              </UITag>
            )}
            {score !== null && <UITag>Score: {score}</UITag>}
          </UISpace>
        }
        description={
          latestRun ? (
            <UISpace split={<span style={{ color: token.colorBorderSecondary }}>|</span>}>
              <span><UIIcon name="ClockCircleOutlined" /> {new Date(latestRun.timestamp).toLocaleString()}</span>
              {latestRun.git && (
                <span>
                  <UIIcon name="BranchesOutlined" /> {latestRun.git.branch} ({latestRun.git.commit.slice(0, 7)})
                </span>
              )}
              <span>tasks: {latestRun.tasks.join(', ')}</span>
            </UISpace>
          ) : undefined
        }
        style={{ marginBottom: token.marginLG }}
      />

      {/* Latest run task strip — compact clickable pills, not a grid of centered cards */}
      {taskGroups.size > 0 && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: token.marginLG }}>
          {[...taskGroups.entries()].map(([task, counts]) => {
            const hasFailed = counts.failed > 0;
            const parts = [`${counts.passed} passed`];
            if (counts.failed > 0) {parts.push(`${counts.failed} failed`);}
            if (counts.cached > 0) {parts.push(`${counts.cached} cached`);}
            return (
              <div
                key={task}
                onClick={() => setDrawerOpen(true)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '8px 12px',
                  borderRadius: token.borderRadius,
                  border: `1px solid ${token.colorBorderSecondary}`,
                  cursor: 'pointer',
                }}
              >
                <UIIcon
                  name={hasFailed ? 'CloseCircleOutlined' : 'CheckCircleOutlined'}
                  style={{ color: hasFailed ? token.colorError : token.colorSuccess }}
                />
                <span style={{ fontWeight: 600, fontSize: token.fontSize }}>{task}</span>
                <span style={{ color: token.colorTextTertiary, fontSize: token.fontSizeSM }}>
                  {parts.join(' · ')}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Baseline Diff */}
      <div style={{ marginBottom: token.marginLG }}>
        <BaselineDiffCard />
      </div>

      {/* Error Groups */}
      <div style={{ marginBottom: token.marginLG }}>
        <ErrorGroupsPanel />
      </div>

      <CheckDetailDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
      />
    </div>
  );
}
