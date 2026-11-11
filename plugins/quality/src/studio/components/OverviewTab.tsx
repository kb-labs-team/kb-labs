import * as React from 'react';
import {
  useData,
  UIRow,
  UICol,
  UICard,
  UIProgress,
  UITag,
  UIAlert,
  UISkeleton,
  UISpace,
  UIIcon,
} from '@kb-labs/sdk/studio';
import type { StatsResponse, HealthV2Response, HistoryResponse, DimensionScores } from '../../contracts/index.js';

function gradeColor(grade?: string): string {
  switch (grade) {
    case 'A': return 'green';
    case 'B': return 'blue';
    case 'C': return 'orange';
    case 'D': return 'red';
    case 'F': return 'volcano';
    default: return 'default';
  }
}

function scoreStatus(score?: number): 'success' | 'exception' | 'normal' {
  if (!score) return 'normal';
  if (score >= 80) return 'success';
  if (score < 60) return 'exception';
  return 'normal';
}

function deltaLabel(value: number, invert = false): React.ReactNode {
  if (value === 0) return null;
  const positive = invert ? value < 0 : value > 0;
  const color = positive ? '#52c41a' : '#ff4d4f';
  const arrow = value > 0 ? '▲' : '▼';
  return <span style={{ color, fontSize: 12, marginLeft: 4 }}>{arrow} {Math.abs(value)}</span>;
}

const DIMENSIONS: Array<{ key: keyof DimensionScores; label: string; icon: string }> = [
  { key: 'architecture', label: 'Architecture', icon: 'ApartmentOutlined' },
  { key: 'typescript', label: 'TypeScript', icon: 'CodeOutlined' },
  { key: 'deadCode', label: 'Dead Code', icon: 'DeleteOutlined' },
  { key: 'depHygiene', label: 'Dep Hygiene', icon: 'NodeIndexOutlined' },
  { key: 'testCoverage', label: 'Test Coverage', icon: 'CheckCircleOutlined' },
];

export function OverviewTab() {
  const { data: statsData, isLoading: statsLoading } = useData<StatsResponse>('/v1/plugins/quality/stats');
  const { data: healthData, isLoading: healthLoading } = useData<HealthV2Response>('/v1/plugins/quality/health');
  const { data: historyData, isLoading: historyLoading } = useData<HistoryResponse>('/v1/plugins/quality/history');

  if (statsLoading || healthLoading || historyLoading) {
    return <UISkeleton active lines={8} style={{ padding: '24px 0' }} />;
  }

  const delta = historyData?.delta;
  const dimensions: DimensionScores | undefined = historyData?.latest?.dimensions ?? healthData?.dimensions;

  return (
    <div>
      {/* Health Score */}
      <UICard title="Health Score" style={{ marginBottom: 24 }}>
        <UIRow gutter={32} align="middle">
          <UICol span={8} style={{ textAlign: 'center' }}>
            <UIProgress
              type="circle"
              percent={healthData?.score ?? 0}
              size={160}
              status={scoreStatus(healthData?.score)}
            />
            <div style={{ marginTop: 12 }}>
              <UITag color={gradeColor(healthData?.grade)} style={{ fontSize: 16, padding: '4px 12px' }}>
                Grade {healthData?.grade ?? '—'}
              </UITag>
              {delta && (
                <div style={{ marginTop: 8, color: '#8c8c8c', fontSize: 13 }}>
                  {deltaLabel(delta.score)} vs previous snapshot
                </div>
              )}
            </div>
          </UICol>

          <UICol span={16}>
            <UIRow gutter={[16, 16]}>
              {DIMENSIONS.map(({ key, label, icon }) => {
                const dim = dimensions ? dimensions[key] : undefined;
                return (
                  <UICol span={12} key={key}>
                    <UICard size="small" style={{ borderRadius: 8 }}>
                      <UISpace>
                        <UIIcon name={icon} />
                        <span style={{ fontWeight: 500 }}>{label}</span>
                        <UITag color={gradeColor(dim?.grade)}>{dim?.grade ?? '—'}</UITag>
                      </UISpace>
                      <UIProgress
                        percent={dim?.score ?? 0}
                        size="small"
                        showInfo={false}
                        strokeColor={
                          (dim?.score ?? 0) >= 80 ? '#52c41a' :
                          (dim?.score ?? 0) >= 60 ? '#faad14' : '#ff4d4f'
                        }
                        style={{ marginTop: 8 }}
                      />
                      <div style={{ fontSize: 12, color: '#8c8c8c', marginTop: 4 }}>
                        {dim?.score ?? 0}/100
                      </div>
                    </UICard>
                  </UICol>
                );
              })}
            </UIRow>
          </UICol>
        </UIRow>
      </UICard>

      {/* Delta summary */}
      {delta && (
        <UIAlert
          variant="info"
          showIcon
          icon={<UIIcon name="LineChartOutlined" />}
          message="Changes since last snapshot"
          description={
            <UIRow gutter={16} style={{ marginTop: 8 }}>
              {[
                { label: 'Layering violations', value: -delta.layeringViolations, invert: true },
                { label: 'Any count', value: -delta.anyCount, invert: true },
                { label: 'Unused files', value: -delta.unusedFiles, invert: true },
                { label: 'Unused deps', value: -delta.unusedDeps, invert: true },
                { label: 'Avg instability', value: -delta.avgInstability, invert: true },
              ].map(({ label, value, invert }) => (
                <UICol key={label}>
                  <span style={{ color: '#8c8c8c' }}>{label}: </span>
                  {deltaLabel(value, invert)}
                  {value === 0 && <span style={{ color: '#8c8c8c' }}>—</span>}
                </UICol>
              ))}
            </UIRow>
          }
          style={{ marginBottom: 24 }}
        />
      )}

      {/* Quick Stats — compact single-row strip, not three separate cards */}
      <UICard styles={{ body: { padding: '18px 24px' } }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
          {[
            { label: 'Packages', value: statsData?.packages ?? 0 },
            { label: 'Lines of Code', value: statsData?.loc ?? 0 },
            { label: 'Total Size', value: statsData?.size ?? 'N/A' },
          ].map((metric, i) => (
            <div key={metric.label} style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
              {i > 0 && <span style={{ width: 1, alignSelf: 'stretch', background: 'var(--border-primary)' }} />}
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                <span style={{
                  fontSize: 20, fontWeight: 700, fontFamily: 'var(--font-heading)',
                  fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.01em',
                }}>
                  {metric.value}
                </span>
                <span style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>{metric.label}</span>
              </div>
            </div>
          ))}
        </div>
      </UICard>
    </div>
  );
}
