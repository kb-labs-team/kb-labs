import * as React from 'react';
import {
  useData,
  UICard,
  UITable,
  UITag,
  UIAlert,
  UISkeleton,
  UISpace,
  UIIcon,
} from '@kb-labs/sdk/studio';
import type { UITableColumn } from '@kb-labs/sdk/studio';
import type { DeadCodeResponse, HealthV2Response } from '../../contracts/index.js';

interface UnusedExportRow { key: string; file: string; symbol: string }
interface UnusedDepRow { key: string; package: string; workspace: string }

const unusedFileColumns: UITableColumn<{ key: string; file: string }>[] = [
  { title: 'File', dataIndex: 'file', key: 'file', ellipsis: true,
    render: (f: string) => <code style={{ fontSize: 12 }}>{f}</code> },
];

const unusedExportColumns: UITableColumn<UnusedExportRow>[] = [
  { title: 'File', dataIndex: 'file', key: 'file', ellipsis: true,
    render: (f: string) => <code style={{ fontSize: 12 }}>{f}</code> },
  { title: 'Symbol', dataIndex: 'symbol', key: 'symbol', width: 200,
    render: (s: string) => <UITag><code>{s}</code></UITag> },
];

const unusedDepColumns: UITableColumn<UnusedDepRow>[] = [
  { title: 'Package', dataIndex: 'package', key: 'package',
    render: (p: string) => <code style={{ fontSize: 12 }}>{p}</code> },
  { title: 'Workspace', dataIndex: 'workspace', key: 'workspace', width: 220,
    render: (w: string) => <UITag>{w}</UITag> },
];

function gradeColor(g: string) {
  return ({ A: 'green', B: 'blue', C: 'orange', D: 'red', F: 'volcano' } as Record<string, string>)[g] ?? 'default';
}

export function DebtTab() {
  const { data: deadData, isLoading: deadLoading } = useData<DeadCodeResponse>('/v1/plugins/quality/dead-code');
  const { data: healthData, isLoading: healthLoading } = useData<HealthV2Response>('/v1/plugins/quality/health');

  if (deadLoading || healthLoading) {
    return <UISkeleton active lines={8} style={{ padding: '24px 0' }} />;
  }

  const tsDetails = healthData?.dimensions?.typescript?.details ?? [];
  const tsScore = healthData?.dimensions?.typescript?.score ?? 100;
  const tsGrade = healthData?.dimensions?.typescript?.grade ?? 'A';

  const unusedFileRows = (deadData?.unusedFiles ?? []).map((f) => ({ key: f, file: f }));
  const unusedExportRows: UnusedExportRow[] = (deadData?.unusedExports ?? []).map((e) => ({
    key: `${e.file}:${e.symbol}`, file: e.file, symbol: e.symbol,
  }));
  const unusedDepRows: UnusedDepRow[] = (deadData?.unusedDependencies ?? []).map((d) => ({
    key: `${d.workspace}:${d.package}`, package: d.package, workspace: d.workspace,
  }));
  const unlistedDepRows: UnusedDepRow[] = (deadData?.unlistedDependencies ?? []).map((d) => ({
    key: `${d.workspace}:${d.package}`, package: d.package, workspace: d.workspace,
  }));

  return (
    <div>
      <UICard styles={{ body: { padding: '18px 24px' } }} style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
          {[
            { label: 'TypeScript Score', value: `${tsScore}/100`, tag: tsGrade },
            {
              label: 'Unused Files', value: unusedFileRows.length,
              color: unusedFileRows.length > 0 ? '#ff4d4f' : '#52c41a',
            },
            {
              label: 'Unused Exports', value: unusedExportRows.length,
              color: unusedExportRows.length > 0 ? '#faad14' : '#52c41a',
            },
            {
              label: 'Dep Issues', value: unusedDepRows.length + unlistedDepRows.length,
              color: (unusedDepRows.length + unlistedDepRows.length) > 0 ? '#faad14' : '#52c41a',
            },
          ].map((metric, i) => (
            <div key={metric.label} style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
              {i > 0 && <span style={{ width: 1, alignSelf: 'stretch', background: 'var(--border-primary)' }} />}
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                {metric.tag && <UITag color={gradeColor(metric.tag)}>{metric.tag}</UITag>}
                <span style={{
                  fontSize: 20, fontWeight: 700, fontFamily: 'var(--font-heading)',
                  fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.01em',
                  color: metric.color,
                }}>
                  {metric.value}
                </span>
                <span style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>{metric.label}</span>
              </div>
            </div>
          ))}
        </div>
      </UICard>

      {tsDetails.length > 0 && (
        <UICard title="TypeScript Health" style={{ marginBottom: 24 }}>
          {tsDetails.map((detail, i) => (
            <UIAlert key={i} variant={tsScore < 60 ? 'error' : tsScore < 80 ? 'warning' : 'info'}
              showIcon message={detail} style={{ marginBottom: 8 }} />
          ))}
        </UICard>
      )}

      {unusedFileRows.length > 0 && (
        <UICard title={<UISpace><UIIcon name="FileUnknownOutlined" /><span>Unused Files</span>
          <UITag color="red">{unusedFileRows.length}</UITag></UISpace>} style={{ marginBottom: 16 }}>
          <UITable dataSource={unusedFileRows} columns={unusedFileColumns} size="small" pagination={{ pageSize: 20 }} />
        </UICard>
      )}

      {unusedExportRows.length > 0 && (
        <UICard title={<UISpace><UIIcon name="ExportOutlined" /><span>Unused Exports</span>
          <UITag color="orange">{unusedExportRows.length}</UITag></UISpace>} style={{ marginBottom: 16 }}>
          <UITable<UnusedExportRow> dataSource={unusedExportRows} columns={unusedExportColumns}
            size="small" pagination={{ pageSize: 20 }} />
        </UICard>
      )}

      {unusedDepRows.length > 0 && (
        <UICard title={<UISpace><UIIcon name="NodeCollapseOutlined" /><span>Unused Dependencies</span>
          <UITag color="orange">{unusedDepRows.length}</UITag></UISpace>} style={{ marginBottom: 16 }}>
          <UITable<UnusedDepRow> dataSource={unusedDepRows} columns={unusedDepColumns}
            size="small" pagination={{ pageSize: 20 }} />
        </UICard>
      )}

      {unlistedDepRows.length > 0 && (
        <UICard title={<UISpace><UIIcon name="WarningOutlined" /><span>Unlisted Dependencies</span>
          <UITag color="red">{unlistedDepRows.length}</UITag></UISpace>}>
          <UITable<UnusedDepRow> dataSource={unlistedDepRows} columns={unusedDepColumns}
            size="small" pagination={{ pageSize: 20 }} />
        </UICard>
      )}

      {unusedFileRows.length === 0 && unusedExportRows.length === 0 &&
       unusedDepRows.length === 0 && unlistedDepRows.length === 0 && (
        <UIAlert variant="success" showIcon icon={<UIIcon name="CheckCircleOutlined" />}
          message="No dead code detected — codebase is clean" />
      )}
    </div>
  );
}
