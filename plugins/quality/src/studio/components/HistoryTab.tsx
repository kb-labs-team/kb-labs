import * as React from 'react';
import {
  useData,
  useMutateData,
  UICard,
  UITable,
  UITag,
  UIAlert,
  UISkeleton,
  UISpace,
  UIIcon,
  UIButton,
  useNotification,
} from '@kb-labs/sdk/studio';
import type { UITableColumn } from '@kb-labs/sdk/studio';
import type { HistoryResponse, QualitySnapshot } from '../../contracts/index.js';

function gradeColor(grade?: string): string {
  return ({ A: 'green', B: 'blue', C: 'orange', D: 'red', F: 'volcano' } as Record<string, string>)[grade ?? ''] ?? 'default';
}

function deltaCell(value: number, lowerIsBetter = true): React.ReactNode {
  if (value === 0) return <span style={{ color: '#8c8c8c' }}>—</span>;
  const good = lowerIsBetter ? value < 0 : value > 0;
  const color = good ? '#52c41a' : '#ff4d4f';
  const arrow = value > 0 ? '▲' : '▼';
  return <span style={{ color }}>{arrow} {Math.abs(value)}</span>;
}

const columns: UITableColumn<QualitySnapshot>[] = [
  { title: 'Date', dataIndex: 'timestamp', key: 'timestamp', width: 170,
    render: (ts: string) => new Date(ts).toLocaleString() },
  { title: 'Score', dataIndex: 'score', key: 'score', width: 80,
    sorter: (a, b) => a.score - b.score },
  { title: 'Grade', dataIndex: 'grade', key: 'grade', width: 70,
    render: (g: string) => <UITag color={gradeColor(g)}>{g}</UITag> },
  { title: 'Architecture', key: 'arch', width: 110,
    render: (_, r) => (
      <UISpace size={4}>
        <UITag color={gradeColor(r.dimensions.architecture.grade)} style={{ fontSize: 11 }}>
          {r.dimensions.architecture.grade}
        </UITag>
        <span style={{ fontSize: 11, color: '#8c8c8c' }}>{r.dimensions.architecture.score}</span>
      </UISpace>
    ) },
  { title: 'TypeScript', key: 'ts', width: 110,
    render: (_, r) => (
      <UISpace size={4}>
        <UITag color={gradeColor(r.dimensions.typescript.grade)} style={{ fontSize: 11 }}>
          {r.dimensions.typescript.grade}
        </UITag>
        <span style={{ fontSize: 11, color: '#8c8c8c' }}>{r.dimensions.typescript.score}</span>
      </UISpace>
    ) },
  { title: 'Dead Code', key: 'dc', width: 110,
    render: (_, r) => (
      <UISpace size={4}>
        <UITag color={gradeColor(r.dimensions.deadCode.grade)} style={{ fontSize: 11 }}>
          {r.dimensions.deadCode.grade}
        </UITag>
        <span style={{ fontSize: 11, color: '#8c8c8c' }}>{r.dimensions.deadCode.score}</span>
      </UISpace>
    ) },
  { title: 'Violations', key: 'violations', width: 95,
    render: (_, r) => (
      <span style={{ color: r.counters.layeringViolations > 0 ? '#ff4d4f' : '#52c41a' }}>
        {r.counters.layeringViolations}
      </span>
    ) },
  { title: 'Any', key: 'any', width: 70, render: (_, r) => r.counters.anyCount },
  { title: 'Unused', key: 'unused', width: 80, render: (_, r) => r.counters.unusedFiles },
  { title: 'Branch', key: 'branch', width: 120, ellipsis: true,
    render: (_, r) => <code style={{ fontSize: 11 }}>{r.git.branch || '—'}</code> },
  { title: 'Commit', key: 'commit', width: 90,
    render: (_, r) => <code style={{ fontSize: 11 }}>{r.git.commit ? r.git.commit.slice(0, 7) : '—'}</code> },
];

export function HistoryTab() {
  const { data, isLoading, refetch } = useData<HistoryResponse>('/v1/plugins/quality/history');
  const saveSnapshot = useMutateData<Record<string, never>, QualitySnapshot>('/v1/plugins/quality/snapshot');
  const notify = useNotification();

  function handleSnapshot() {
    saveSnapshot.mutate({}, {
      onSuccess: () => {
        notify.success('Snapshot saved');
        void refetch();
      },
      onError: (err: unknown) => {
        notify.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
      },
    });
  }

  if (isLoading) {
    return <UISkeleton active lines={8} style={{ padding: '24px 0' }} />;
  }

  const snapshots = data?.snapshots ?? [];
  const delta = data?.delta;
  const hasAnyDelta = delta && Object.values(delta).some(v => v !== 0);

  return (
    <div>
      {delta && (
        <UICard title="Changes since last snapshot" style={{ marginBottom: 24 }}>
          {!hasAnyDelta ? (
            <span style={{ color: '#8c8c8c', fontSize: 13 }}>No changes since last snapshot</span>
          ) : (
            <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap' }}>
              <div><span style={{ color: '#8c8c8c' }}>Score </span>{deltaCell(delta.score, false)}</div>
              <div><span style={{ color: '#8c8c8c' }}>Violations </span>{deltaCell(delta.layeringViolations)}</div>
              <div><span style={{ color: '#8c8c8c' }}>Any count </span>{deltaCell(delta.anyCount)}</div>
              <div><span style={{ color: '#8c8c8c' }}>Ts-ignore </span>{deltaCell(delta.tsIgnoreCount)}</div>
              <div><span style={{ color: '#8c8c8c' }}>Unused files </span>{deltaCell(delta.unusedFiles)}</div>
              <div><span style={{ color: '#8c8c8c' }}>Unused deps </span>{deltaCell(delta.unusedDeps)}</div>
              <div><span style={{ color: '#8c8c8c' }}>Avg instability </span>{deltaCell(parseFloat(delta.avgInstability.toFixed(2)))}</div>
            </div>
          )}
        </UICard>
      )}

      <UICard
        title={`Snapshot History (${snapshots.length})`}
        extra={
          <UIButton size="small" icon={<UIIcon name="CameraOutlined" />}
            loading={saveSnapshot.isLoading} onClick={handleSnapshot}>
            Save Snapshot
          </UIButton>
        }
      >
        {snapshots.length === 0 ? (
          <UIAlert variant="info" showIcon icon={<UIIcon name="InfoCircleOutlined" />}
            message="No snapshots yet"
            description='Run "kb quality snapshot create" or click "Save Snapshot" to start tracking trends.' />
        ) : (
          <UITable<QualitySnapshot>
            dataSource={snapshots.slice().reverse()}
            columns={columns}
            rowKey="id"
            size="small"
            pagination={{ pageSize: 20 }}
            scroll={{ x: 1200 }}
          />
        )}
      </UICard>
    </div>
  );
}
