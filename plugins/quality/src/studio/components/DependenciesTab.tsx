/**
 * Dependencies tab - shows duplicates, unused, and missing dependencies
 */

import * as React from 'react';
import { useData, UICard, UITable, UITag, UISkeleton, UIAlert } from '@kb-labs/sdk/studio';
import type { UITableColumn } from '@kb-labs/sdk/studio';
import type {
  DependenciesResponse,
  DuplicateDependency,
  VersionInfo,
  UnusedDependency,
  MissingDependency,
} from '../../contracts/index.js';

export function DependenciesTab() {
  const { data, isLoading, isError } = useData<DependenciesResponse>(
    '/v1/plugins/quality/dependencies',
  );

  if (isLoading) {
    return <UISkeleton active lines={6} style={{ padding: '24px 0' }} />;
  }

  if (isError) {
    return <UIAlert message="Failed to load dependencies" variant="error" showIcon />;
  }

  const duplicatesColumns: UITableColumn<DuplicateDependency>[] = [
    {
      title: 'Dependency',
      dataIndex: 'name',
      key: 'name',
      sorter: (a, b) => a.name.localeCompare(b.name),
    },
    {
      title: 'Versions',
      dataIndex: 'versions',
      key: 'versions',
      render: (versions: VersionInfo[]) => (
        <>
          {versions.map((v) => (
            <UITag key={v.version} color="orange">
              {v.version} ({v.count})
            </UITag>
          ))}
        </>
      ),
    },
    {
      title: 'Total Packages',
      dataIndex: 'totalPackages',
      key: 'totalPackages',
      sorter: (a, b) => a.totalPackages - b.totalPackages,
    },
  ];

  const unusedColumns: UITableColumn<UnusedDependency>[] = [
    {
      title: 'Dependency',
      dataIndex: 'name',
      key: 'name',
      sorter: (a, b) => a.name.localeCompare(b.name),
    },
    {
      title: 'Packages',
      dataIndex: 'packages',
      key: 'packages',
      render: (packages: string[]) => packages.join(', '),
    },
  ];

  const missingColumns: UITableColumn<MissingDependency>[] = [
    {
      title: 'Dependency',
      dataIndex: 'name',
      key: 'name',
      sorter: (a, b) => a.name.localeCompare(b.name),
    },
    {
      title: 'Packages',
      dataIndex: 'packages',
      key: 'packages',
      render: (packages: string[]) => packages.join(', '),
    },
    {
      title: 'Imported In',
      dataIndex: 'importedIn',
      key: 'importedIn',
      render: (files: string[]) => files.join(', '),
    },
  ];

  return (
    <div>
      {data && data.totalIssues === 0 && (
        <UIAlert
          message="No dependency issues found!"
          description="Your monorepo has no duplicate, unused, or missing dependencies."
          variant="success"
          showIcon
          style={{ marginBottom: 24 }}
        />
      )}

      {/* Duplicates */}
      <UICard
        title={`Duplicate Dependencies (${data?.duplicates?.length ?? 0})`}
        style={{ marginBottom: 24 }}
      >
        <UITable
          dataSource={data?.duplicates ?? []}
          columns={duplicatesColumns}
          rowKey="name"
          pagination={{ pageSize: 10 }}
        />
      </UICard>

      {/* Unused */}
      <UICard
        title={`Unused Dependencies (${data?.unused?.length ?? 0})`}
        style={{ marginBottom: 24 }}
      >
        <UITable
          dataSource={data?.unused ?? []}
          columns={unusedColumns}
          rowKey="name"
          pagination={{ pageSize: 10 }}
        />
      </UICard>

      {/* Missing */}
      <UICard title={`Missing Dependencies (${data?.missing?.length ?? 0})`}>
        <UITable
          dataSource={data?.missing ?? []}
          columns={missingColumns}
          rowKey="name"
          pagination={{ pageSize: 10 }}
        />
      </UICard>
    </div>
  );
}
