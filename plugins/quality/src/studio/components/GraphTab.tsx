/**
 * Dependency Graph tab - visualizes package dependencies
 */

import * as React from 'react';
import type { DataNode } from 'antd/es/tree';
import { useData, UICard, UISelect, UISkeleton, UIAlert, UITree } from '@kb-labs/sdk/studio';
import type { GraphResponse, BuildOrderResponse, GraphMode, GraphNode } from '../../contracts/index.js';

export function GraphTab() {
  const [mode, setMode] = React.useState<GraphMode>('stats');
  const [selectedPackage, setSelectedPackage] = React.useState<string | undefined>();

  const { data: buildOrderData } = useData<BuildOrderResponse>('/v1/plugins/quality/build-order');

  // Auto-select first package when switching to modes that require packageName
  React.useEffect(() => {
    if ((mode === 'reverse' || mode === 'impact') && !selectedPackage && buildOrderData?.sorted?.[0]) {
      setSelectedPackage(buildOrderData.sorted[0]);
    }
  }, [mode, selectedPackage, buildOrderData]);

  const graphUrl = selectedPackage
    ? `/v1/plugins/quality/graph?mode=${mode}&package=${encodeURIComponent(selectedPackage)}`
    : `/v1/plugins/quality/graph?mode=${mode}`;

  const { data, isLoading, isError } = useData<GraphResponse>(graphUrl);

  if (isLoading) {
    return <UISkeleton active lines={6} style={{ padding: '24px 0' }} />;
  }

  if (isError) {
    return <UIAlert message="Failed to load graph" variant="error" showIcon />;
  }

  const convertToTreeData = (node: GraphNode, path: string = ''): DataNode => {
    const key = path ? `${path}/${node.name}` : node.name;
    return {
      title: node.name,
      key,
      children: node.children?.map((child) => convertToTreeData(child, key)),
    };
  };

  const renderTreeMode = () => {
    if (!data?.tree) {
      return <UIAlert message="No tree data available" variant="info" />;
    }
    return (
      <UITree
        treeData={[convertToTreeData(data.tree)]}
        showLine
        defaultExpandedKeys={[data.tree.name]}
      />
    );
  };

  const renderPackagesMode = () => {
    if (!data?.packages || data.packages.length === 0) {
      return <UIAlert message="No packages found" variant="info" />;
    }
    return (
      <ul>
        {data.packages.map((pkg) => (
          <li key={pkg}>{pkg}</li>
        ))}
      </ul>
    );
  };

  const renderStatsMode = () => {
    if (!data?.stats) {
      return <UIAlert message="No stats available" variant="info" />;
    }
    return (
      <div>
        <UICard styles={{ body: { padding: '18px 24px' } }} style={{ marginBottom: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
            {[
              { label: 'Total Packages', value: data.stats.totalPackages },
              { label: 'Max Depth', value: data.stats.maxDepth },
              { label: 'Avg Dependencies', value: data.stats.avgDependencies.toFixed(1) },
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
        {data.stats.mostDepended && data.stats.mostDepended.length > 0 && (
          <UICard title="Most Depended On">
            <ul>
              {data.stats.mostDepended.map((item) => (
                <li key={item.name}>
                  <strong>{item.name}</strong> - {item.count} packages depend on it
                </li>
              ))}
            </ul>
          </UICard>
        )}
      </div>
    );
  };

  return (
    <div>
      {/* Toolbar — one row, no labels, placeholders do the talking */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 24 }}>
        <UISelect
          style={{ width: 200 }}
          value={mode}
          onChange={(val) => setMode(val as GraphMode)}
          options={[
            { label: 'Dependency Tree', value: 'tree' },
            { label: 'Reverse Dependencies', value: 'reverse' },
            { label: 'Impact Analysis', value: 'impact' },
            { label: 'Statistics', value: 'stats' },
          ]}
        />
        {mode !== 'stats' && (
          <UISelect
            style={{ width: 260 }}
            placeholder={mode === 'tree' ? 'All packages' : 'Select a package'}
            value={selectedPackage}
            onChange={(val) => setSelectedPackage(val as string | undefined)}
            allowClear
            showSearch
            options={buildOrderData?.sorted?.map((pkg) => ({ label: pkg, value: pkg })) ?? []}
          />
        )}
      </div>

      {/* Visualization */}
      <UICard title={`${mode.charAt(0).toUpperCase() + mode.slice(1)} View`}>
        {mode === 'tree' && renderTreeMode()}
        {(mode === 'reverse' || mode === 'impact') && renderPackagesMode()}
        {mode === 'stats' && renderStatsMode()}
      </UICard>
    </div>
  );
}
