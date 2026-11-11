/**
 * Build Order tab - shows parallel build layers and sequential order
 */

import * as React from 'react';
import { useData, UICard, UITable, UITag, UISkeleton, UIAlert, UISelect, UISpace } from '@kb-labs/sdk/studio';
import type { UITableColumn } from '@kb-labs/sdk/studio';
import type { BuildOrderResponse, CyclesResponse } from '../../contracts/index.js';

export function BuildOrderTab() {
  const [selectedPackage, setSelectedPackage] = React.useState<string | undefined>();

  const buildOrderUrl = selectedPackage
    ? `/v1/plugins/quality/build-order?package=${encodeURIComponent(selectedPackage)}`
    : '/v1/plugins/quality/build-order';

  const { data, isLoading, isError } = useData<BuildOrderResponse>(buildOrderUrl);
  const { data: cyclesData } = useData<CyclesResponse>('/v1/plugins/quality/cycles');

  if (isLoading) {
    return <UISkeleton active lines={6} style={{ padding: '24px 0' }} />;
  }

  if (isError) {
    return <UIAlert message="Failed to load build order" variant="error" showIcon />;
  }

  const layersColumns: UITableColumn<{ layer: number; packages: string[]; key: number }>[] = [
    {
      title: 'Layer',
      dataIndex: 'layer',
      key: 'layer',
      width: 100,
      render: (layer: number) => <UITag color="blue">Layer {layer}</UITag>,
    },
    {
      title: 'Packages (can build in parallel)',
      dataIndex: 'packages',
      key: 'packages',
      render: (packages: string[]) => (
        <UISpace wrap>
          {packages.map((pkg) => (
            <UITag key={pkg}>{pkg}</UITag>
          ))}
        </UISpace>
      ),
    },
  ];

  const layersData = data?.layers.map((layer, idx) => ({
    layer: idx + 1,
    packages: layer,
    key: idx,
  }));

  return (
    <div>
      {/* Circular Dependencies Warning */}
      {data?.hasCircular && (
        <UIAlert
          message="Circular Dependencies Detected!"
          description={`Found ${data.circular.length} circular dependency cycles. Build order may not be correct.`}
          variant="error"
          showIcon
          style={{ marginBottom: 24 }}
        />
      )}

      {/* Package Filter */}
      <UICard title="Filter" style={{ marginBottom: 24 }}>
        <UISelect
          style={{ width: 400 }}
          placeholder="Select package to see its build dependencies"
          value={selectedPackage}
          onChange={(val) => setSelectedPackage(val as string | undefined)}
          allowClear
          showSearch
          options={data?.sorted.map((pkg) => ({
            label: pkg,
            value: pkg,
          })) ?? []}
        />
      </UICard>

      {/* Build Layers */}
      <UICard
        title={`Build Layers (${data?.layerCount ?? 0} layers, ${data?.packageCount ?? 0} packages)`}
        style={{ marginBottom: 24 }}
      >
        <UITable
          dataSource={layersData ?? []}
          columns={layersColumns}
          pagination={false}
          expandable={{
            expandedRowRender: (record) => (
              <div style={{ padding: '8px 0' }}>
                <strong>Packages in this layer:</strong>
                <div style={{ marginTop: 8 }}>
                  {record.packages.map((pkg) => (
                    <UITag key={pkg} style={{ marginBottom: 4 }}>
                      {pkg}
                    </UITag>
                  ))}
                </div>
              </div>
            ),
          }}
        />
      </UICard>

      {/* Circular Dependencies */}
      {data?.hasCircular && (
        <UICard title={`Circular Dependencies (${data.circular.length})`}>
          {data.circular.map((cycle, idx) => (
            <UIAlert
              key={idx}
              message={`Cycle ${idx + 1}`}
              description={cycle.join(' → ')}
              variant="warning"
              showIcon
              style={{ marginBottom: 12 }}
            />
          ))}
        </UICard>
      )}
    </div>
  );
}
