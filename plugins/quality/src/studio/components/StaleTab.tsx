/**
 * Stale Packages tab - shows packages that need rebuilding
 */

import * as React from 'react';
import { useData, UICard, UITable, UITag, UISkeleton, UIAlert, UISpace, UIButton, UITypographyText, UIIcon } from '@kb-labs/sdk/studio';
import type { UITableColumn } from '@kb-labs/sdk/studio';
import type { StaleResponse, StalePackage, StaleChain } from '../../contracts/index.js';

const Text = UITypographyText;

export function StaleTab() {
  const { data, isLoading, isError } = useData<StaleResponse>(
    '/v1/plugins/quality/stale?detailed=true',
  );

  if (isLoading) {
    return <UISkeleton active lines={6} style={{ padding: '24px 0' }} />;
  }

  if (isError) {
    return <UIAlert message="Failed to load stale packages" variant="error" showIcon />;
  }

  const getSeverityColor = (severity: string): string => {
    switch (severity) {
      case 'critical': return 'red';
      case 'high': return 'orange';
      case 'medium': return 'gold';
      case 'low': return 'blue';
      default: return 'default';
    }
  };

  const getReasonText = (reason: string): string => {
    switch (reason) {
      case 'source-newer': return 'Source Modified';
      case 'dependency-rebuilt': return 'Dependency Rebuilt';
      case 'missing-dist': return 'Missing Build';
      default: return reason;
    }
  };

  const getReasonColor = (reason: string): string => {
    switch (reason) {
      case 'source-newer': return 'orange';
      case 'dependency-rebuilt': return 'blue';
      case 'missing-dist': return 'red';
      default: return 'default';
    }
  };

  const staleColumns: UITableColumn<StalePackage>[] = [
    {
      title: 'Package',
      dataIndex: 'name',
      key: 'name',
      sorter: (a, b) => a.name.localeCompare(b.name),
      render: (name: string) => <code>{name}</code>,
    },
    {
      title: 'Reason',
      dataIndex: 'reason',
      key: 'reason',
      filters: [
        { text: 'Source Modified', value: 'source-newer' },
        { text: 'Dependency Rebuilt', value: 'dependency-rebuilt' },
        { text: 'Missing Build', value: 'missing-dist' },
      ],
      onFilter: (value, record) => record.reason === value,
      render: (reason: string) => (
        <UITag color={getReasonColor(reason)}>{getReasonText(reason)}</UITag>
      ),
    },
    {
      title: 'Severity',
      dataIndex: 'severity',
      key: 'severity',
      sorter: (a, b) => {
        const order = ['critical', 'high', 'medium', 'low'];
        return order.indexOf(a.severity) - order.indexOf(b.severity);
      },
      filters: [
        { text: 'Critical', value: 'critical' },
        { text: 'High', value: 'high' },
        { text: 'Medium', value: 'medium' },
        { text: 'Low', value: 'low' },
      ],
      onFilter: (value, record) => record.severity === value,
      render: (severity: string) => (
        <UITag color={getSeverityColor(severity)}>{severity.toUpperCase()}</UITag>
      ),
    },
    {
      title: 'Affected',
      dataIndex: 'affectedCount',
      key: 'affectedCount',
      sorter: (a, b) => a.affectedCount - b.affectedCount,
      render: (count: number) => (
        <Text type={count > 10 ? 'danger' : count > 5 ? 'warning' : 'secondary'}>
          {count} package{count !== 1 ? 's' : ''}
        </Text>
      ),
    },
    {
      title: 'Modified',
      key: 'modified',
      render: (_, record) => {
        if (record.sourceModified) {
          return (
            <UISpace direction="vertical" size={0}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                Source: {new Date(record.sourceModified).toLocaleString()}
              </Text>
              {record.distModified && (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  Dist: {new Date(record.distModified).toLocaleString()}
                </Text>
              )}
            </UISpace>
          );
        }
        return <Text type="secondary">-</Text>;
      },
    },
  ];

  const chainColumns: UITableColumn<StaleChain>[] = [
    {
      title: 'Root Package',
      dataIndex: 'root',
      key: 'root',
      render: (root: string) => <code>{root}</code>,
    },
    {
      title: 'Depth',
      dataIndex: 'depth',
      key: 'depth',
      sorter: (a, b) => a.depth - b.depth,
      render: (depth: number) => (
        <UITag color={depth > 5 ? 'red' : depth > 3 ? 'orange' : 'blue'}>{depth} levels</UITag>
      ),
    },
    {
      title: 'Affected Packages',
      dataIndex: 'affected',
      key: 'affected',
      sorter: (a, b) => a.affected.length - b.affected.length,
      render: (affected: string[]) => (
        <Text type={affected.length > 20 ? 'danger' : 'secondary'}>
          {affected.length} package{affected.length !== 1 ? 's' : ''}
        </Text>
      ),
    },
  ];

  return (
    <div>
      {/* Summary Alert */}
      {data && data.totalStale > 0 ? (
        <UIAlert
          variant="error"
          showIcon
          icon={<UIIcon name="ClockCircleOutlined" />}
          message={
            <UISpace>
              <strong>
                {data.totalStale} stale package{data.totalStale > 1 ? 's' : ''} detected
              </strong>
              <Text type="secondary">
                affecting {data.totalAffected} downstream package{data.totalAffected > 1 ? 's' : ''}
              </Text>
            </UISpace>
          }
          action={
            <UISpace>
              <UIButton variant="primary" danger icon={<UIIcon name="ThunderboltOutlined" />} size="small">
                Rebuild All
              </UIButton>
              <UIButton size="small">Export Report</UIButton>
            </UISpace>
          }
          style={{ marginBottom: 24 }}
        />
      ) : (
        <UIAlert
          variant="success"
          showIcon
          message="All packages are up to date"
          description="No stale packages detected. Your monorepo build state is healthy."
          style={{ marginBottom: 24 }}
        />
      )}

      {/* Critical Chains */}
      {data?.criticalChains && data.criticalChains.length > 0 && (
        <UICard
          title={
            <UISpace>
              <UIIcon name="WarningOutlined" style={{ color: '#ff4d4f' }} />
              Critical Rebuild Chains
            </UISpace>
          }
          style={{ marginBottom: 24 }}
        >
          <UIAlert
            variant="warning"
            showIcon
            message="High-impact stale packages"
            description="These packages affect many downstream packages. Rebuilding them will trigger cascading rebuilds."
            style={{ marginBottom: 16 }}
          />
          <UITable
            dataSource={data.criticalChains}
            columns={chainColumns}
            rowKey="root"
            pagination={{ pageSize: 5 }}
          />
        </UICard>
      )}

      {/* Stale Packages Table */}
      <UICard
        title={
          <UISpace>
            <UIIcon name="FileOutlined" />
            Stale Packages
          </UISpace>
        }
      >
        <UITable
          dataSource={data?.stalePackages ?? []}
          columns={staleColumns}
          rowKey="name"
          pagination={{ pageSize: 20 }}
          expandable={{
            expandedRowRender: (record) => (
              <div style={{ padding: '8px 16px' }}>
                <UISpace direction="vertical" size={8} style={{ width: '100%' }}>
                  <div>
                    <Text strong>Path: </Text>
                    <Text type="secondary" code>
                      {record.path}
                    </Text>
                  </div>
                  {record.affectedPackages && record.affectedPackages.length > 0 && (
                    <div>
                      <Text strong>Affected Packages ({record.affectedPackages.length}):</Text>
                      <div style={{ marginTop: 8 }}>
                        {record.affectedPackages.slice(0, 10).map((pkg: string) => (
                          <UITag key={pkg} style={{ marginBottom: 4 }}>
                            {pkg}
                          </UITag>
                        ))}
                        {record.affectedPackages.length > 10 && (
                          <UITag>+{record.affectedPackages.length - 10} more</UITag>
                        )}
                      </div>
                    </div>
                  )}
                </UISpace>
              </div>
            ),
          }}
        />
      </UICard>
    </div>
  );
}
