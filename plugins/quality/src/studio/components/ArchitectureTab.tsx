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
import type { LayeringResponse, CouplingResponse } from '../../contracts/index.js';
import type { LayeringViolation, PackageCoupling } from '../../contracts/index.js';

function instabilityColor(instability: number): string {
  if (instability >= 0.8) return '#ff4d4f';
  if (instability >= 0.6) return '#faad14';
  if (instability >= 0.4) return '#1677ff';
  return '#52c41a';
}

function instabilityTag(instability: number): React.ReactNode {
  return (
    <UITag color={instabilityColor(instability)}>
      {instability.toFixed(2)}
    </UITag>
  );
}

const couplingColumns: UITableColumn<PackageCoupling>[] = [
  {
    title: 'Package',
    dataIndex: 'name',
    key: 'name',
    render: (name: string) => <code style={{ fontSize: 12 }}>{name}</code>,
    ellipsis: true,
  },
  {
    title: 'Ca (afferent)',
    dataIndex: 'afferent',
    key: 'afferent',
    width: 110,
    sorter: (a, b) => a.afferent - b.afferent,
  },
  {
    title: 'Ce (efferent)',
    dataIndex: 'efferent',
    key: 'efferent',
    width: 110,
    sorter: (a, b) => a.efferent - b.efferent,
  },
  {
    title: 'Instability',
    dataIndex: 'instability',
    key: 'instability',
    width: 110,
    defaultSortOrder: 'descend',
    sorter: (a, b) => a.instability - b.instability,
    render: (v: number) => instabilityTag(v),
  },
];

const violationColumns: UITableColumn<LayeringViolation>[] = [
  {
    title: 'File',
    dataIndex: 'file',
    key: 'file',
    ellipsis: true,
    render: (f: string) => <code style={{ fontSize: 11 }}>{f.replace(/^.*\/src\//, 'src/')}</code>,
  },
  {
    title: 'From',
    key: 'from',
    width: 180,
    render: (_, r) => (
      <UISpace size={4}>
        <UITag>{r.fromPackage}</UITag>
        <span style={{ color: '#8c8c8c', fontSize: 11 }}>L{r.fromLayer}</span>
      </UISpace>
    ),
  },
  {
    title: 'To',
    key: 'to',
    width: 180,
    render: (_, r) => (
      <UISpace size={4}>
        <UITag color="red">{r.toPackage}</UITag>
        <span style={{ color: '#8c8c8c', fontSize: 11 }}>L{r.toLayer}</span>
      </UISpace>
    ),
  },
  {
    title: 'Import',
    dataIndex: 'importSpecifier',
    key: 'importSpecifier',
    ellipsis: true,
    render: (s: string) => <code style={{ fontSize: 11 }}>{s}</code>,
  },
];

export function ArchitectureTab() {
  const { data: couplingData, isLoading: couplingLoading } = useData<CouplingResponse>('/v1/plugins/quality/coupling');
  const { data: layersData, isLoading: layersLoading } = useData<LayeringResponse>('/v1/plugins/quality/layers');

  if (couplingLoading || layersLoading) {
    return <UISkeleton active lines={10} style={{ padding: '24px 0' }} />;
  }

  const hasViolations = (layersData?.totalViolations ?? 0) > 0;

  return (
    <div>
      {/* Summary strip — single row, not three separate cards */}
      <UICard styles={{ body: { padding: '18px 24px' } }} style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
          {[
            {
              label: 'Layering Violations',
              value: layersData?.totalViolations ?? 0,
              color: hasViolations ? '#ff4d4f' : '#52c41a',
            },
            { label: 'Avg Instability', value: (couplingData?.avgInstability ?? 0).toFixed(2) },
            { label: 'Affected Packages', value: layersData?.affectedPackages?.length ?? 0 },
          ].map((metric, i) => (
            <div key={metric.label} style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
              {i > 0 && <span style={{ width: 1, alignSelf: 'stretch', background: 'var(--border-primary)' }} />}
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
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

      {/* Layering violations */}
      {hasViolations && (
        <UIAlert
          variant="error"
          showIcon
          icon={<UIIcon name="WarningOutlined" />}
          message={`${layersData!.totalViolations} layering violation${layersData!.totalViolations > 1 ? 's' : ''} detected`}
          description="Lower-layer packages are importing from higher-layer packages, breaking the dependency rules."
          style={{ marginBottom: 16 }}
        />
      )}

      <UICard title="Layering Violations" style={{ marginBottom: 24 }}>
        {!hasViolations ? (
          <UIAlert
            variant="success"
            showIcon
            icon={<UIIcon name="CheckCircleOutlined" />}
            message="No layering violations — architecture is clean"
          />
        ) : (
          <UITable<LayeringViolation>
            dataSource={layersData?.violations ?? []}
            columns={violationColumns}
            rowKey={(r) => `${r.file}:${r.importSpecifier}`}
            size="small"
            pagination={{ pageSize: 20 }}
          />
        )}
      </UICard>

      {/* Coupling metrics */}
      <UICard title="Package Coupling (Ca/Ce/Instability)">
        <UITable<PackageCoupling>
          dataSource={couplingData?.packages ?? []}
          columns={couplingColumns}
          rowKey="name"
          size="small"
          pagination={{ pageSize: 30 }}
        />
      </UICard>
    </div>
  );
}
