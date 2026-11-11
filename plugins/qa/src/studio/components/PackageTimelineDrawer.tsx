/**
 * Drawer showing per-package QA history timeline with flaky detection.
 */

import * as React from 'react';
import {
  UIDrawer,
  UITable,
  UITag,
  UITypographyText,
  UIStatistic,
  UIRow,
  UICol,
  UISkeleton,
  UIAlert,
  UISpace,
  UIIcon,
  useData,
  useTheme,
} from '@kb-labs/sdk/studio';
import type { PackageTimeline, PackageTaskHistory } from '../../contracts/index.js';
import { QA_BASE_PATH } from '../../contracts/index.js';

interface PackageTimelineDrawerProps {
  open: boolean;
  packageName: string | null;
  onClose: () => void;
}

const TASK_STATUS_TAG: Record<string, { color: string; iconName: string }> = {
  passed: { color: 'success', iconName: 'CheckCircleOutlined' },
  failed: { color: 'error', iconName: 'CloseCircleOutlined' },
  cached: { color: 'default', iconName: 'ThunderboltOutlined' },
};

export function PackageTimelineDrawer({ open, packageName, onClose }: PackageTimelineDrawerProps) {
  const { antdToken: token } = useTheme();
  const timelineUrl = packageName
    ? `${QA_BASE_PATH}/packages/${encodeURIComponent(packageName)}/timeline`
    : null;
  const { data, isLoading } = useData<PackageTimeline>(timelineUrl ?? '');

  if (!packageName) { return null; }

  return (
    <UIDrawer
      title={
        <UISpace>
          <span>Timeline: {packageName}</span>
          {data && data.flakyScore > 0.3 && (
            <UITag color="warning" icon={<UIIcon name="WarningOutlined" />}>Flaky</UITag>
          )}
        </UISpace>
      }
      placement="right"
      width={700}
      open={open}
      onClose={onClose}
    >
      {isLoading && (
        <UISkeleton active lines={5} />
      )}

      {!isLoading && !data && (
        <UIAlert variant="info" message={`No history found for ${packageName}`} />
      )}

      {!isLoading && data && (
        <div>
          <UIRow gutter={16} style={{ marginBottom: token.marginLG }}>
            <UICol span={8}>
              <UIStatistic
                title="Current Streak"
                value={data.currentStreak.count}
                prefix={
                  data.currentStreak.status === 'failing'
                    ? <UIIcon name="FireOutlined" />
                    : <UIIcon name="CheckCircleOutlined" />
                }
                suffix={data.currentStreak.status}
                valueStyle={{
                  fontSize: token.fontSize,
                  color: data.currentStreak.status === 'failing' ? token.colorError : token.colorSuccess,
                }}
              />
            </UICol>
            <UICol span={8}>
              <UIStatistic
                title="Flaky Score"
                value={Math.round(data.flakyScore * 100)}
                suffix="%"
                valueStyle={{
                  fontSize: token.fontSize,
                  color: data.flakyScore > 0.3 ? token.colorWarning : token.colorSuccess,
                }}
              />
            </UICol>
            <UICol span={8}>
              {data.firstFailure && (
                <UIStatistic
                  title="First Failure"
                  value={new Date(data.firstFailure).toLocaleDateString()}
                  valueStyle={{ fontSize: token.fontSize }}
                />
              )}
            </UICol>
          </UIRow>

          {data.flakyTasks.length > 0 && (
            <UIAlert
              variant="warning"
              showIcon
              icon={<UIIcon name="WarningOutlined" />}
              message="Flaky tasks detected"
              description={
                <UISpace>
                  {data.flakyTasks.map((task) => (
                    <UITag key={task} color="warning">{task}</UITag>
                  ))}
                </UISpace>
              }
              style={{ marginBottom: token.marginMD }}
            />
          )}

          <UITable<PackageTaskHistory>
            dataSource={data.history}
            rowKey={(record) => `${record.timestamp}-${record.task}`}
            size="small"
            pagination={{ pageSize: 20 }}
            columns={[
              {
                title: 'Date',
                dataIndex: 'timestamp',
                key: 'timestamp',
                width: 160,
                render: (ts: string) => new Date(ts).toLocaleString(),
                sorter: (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
                defaultSortOrder: 'descend',
              },
              {
                title: 'Task',
                dataIndex: 'task',
                key: 'task',
                width: 120,
                render: (task: string) => <UITag>{task}</UITag>,
                filters: [...new Set(data.history.map(h => h.task))].map(t => ({ text: t, value: t })),
                onFilter: (value, record) => record.task === value,
              },
              {
                title: 'Commit',
                dataIndex: 'gitCommit',
                key: 'gitCommit',
                width: 100,
                render: (commit: string) => (
                  <UITypographyText code style={{ fontSize: token.fontSizeSM }}>
                    {commit.slice(0, 7)}
                  </UITypographyText>
                ),
              },
              {
                title: 'Status',
                dataIndex: 'status',
                key: 'status',
                width: 100,
                render: (status: keyof typeof TASK_STATUS_TAG) => {
                  const cfg = TASK_STATUS_TAG[status];
                  return cfg
                    ? <UITag color={cfg.color} icon={<UIIcon name={cfg.iconName} />}>{status}</UITag>
                    : <UITag>{status}</UITag>;
                },
                filters: [
                  { text: 'Passed', value: 'passed' },
                  { text: 'Failed', value: 'failed' },
                  { text: 'Cached', value: 'cached' },
                ],
                onFilter: (value, record) => record.status === value,
              },
            ]}
          />
        </div>
      )}
    </UIDrawer>
  );
}
