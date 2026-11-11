/**
 * Step 3: Preview package contents before release
 */

import * as React from 'react';
import {
  UICard,
  UISpace,
  UITypographyText,
  UITitle,
  UITag,
  UISpin,
  UIEmptyState,
  UITable,
  UIProgress,
  UIButton,
  UIAlert,
  UIMessage,
  UIIcon,
} from '@kb-labs/sdk/studio';
import { useData, useMutateData, useTheme } from '@kb-labs/sdk/studio';
import type { PreviewResponse, BuildRequest, BuildResponse } from '../../../contracts/index.js';

function formatBytes(bytes: number): string {
  if (bytes === 0) { return '0 B'; }
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function getFileExtension(path: string): string {
  const parts = path.split('.');
  return parts.length > 1 ? (parts[parts.length - 1] ?? '') : '';
}

function getFileTypeColor(path: string): string {
  const ext = getFileExtension(path);
  switch (ext) {
    case 'js': case 'mjs': case 'cjs': return '#f5a623';
    case 'ts': case 'tsx': return '#3178c6';
    case 'd.ts': return '#235a97';
    case 'json': return '#5a9c5a';
    case 'md': return '#083fa1';
    case 'map': return '#8c8c8c';
    default: return '#595959';
  }
}

interface PreviewStepProps {
  selectedScope: string;
  onPreviewReady: (ready: boolean) => void;
}

export function PreviewStep({ selectedScope, onPreviewReady }: PreviewStepProps) {
  const { antdToken: token } = useTheme();
  const previewUrl = selectedScope ? `/v1/plugins/release/preview?scope=${encodeURIComponent(selectedScope)}` : '';
  const { data: previewData, isLoading, error, refetch } = useData<PreviewResponse>(previewUrl);
  const { mutateAsync: triggerBuild, isLoading: buildLoading } = useMutateData<BuildRequest, BuildResponse>(
    '/v1/plugins/release/build',
    'POST',
  );

  const needsBuild = previewData?.packages.some((pkg) => pkg.buildStatus !== 'ready') ?? false;
  const allBuilt = previewData?.allBuilt ?? false;

  React.useEffect(() => {
    if (previewData && previewData.packages.length > 0 && allBuilt) {
      onPreviewReady(true);
    } else {
      onPreviewReady(false);
    }
  }, [previewData, allBuilt, onPreviewReady]);

  const handleBuild = async () => {
    try {
      const result = await triggerBuild({ scope: selectedScope });
      if (result.success) {
        UIMessage.success(`Build completed: ${result.builtCount}/${result.totalCount} packages`);
        refetch();
      } else {
        UIMessage.error('Build failed');
      }
    } catch (err) {
      UIMessage.error(`Build failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  };

  if (isLoading) {
    return (
      <UICard>
        <div style={{ textAlign: 'center', padding: 48 }}>
          <UISpin size="large" />
          <div style={{ marginTop: 16 }}>
            <UITypographyText type="secondary">Analyzing package contents...</UITypographyText>
          </div>
        </div>
      </UICard>
    );
  }

  if (error) {
    return (
      <UICard>
        <UIEmptyState
          description={`Failed to load package preview: ${error instanceof Error ? error.message : 'Unknown error'}`}
        />
      </UICard>
    );
  }

  if (!previewData || previewData.packages.length === 0) {
    return (
      <UICard>
        <UIEmptyState description="No packages found in release plan. Generate a plan first." />
      </UICard>
    );
  }

  const totalFiles = previewData.totalFiles;
  const totalSize = previewData.totalSize;

  const fileTypes = new Map<string, { count: number; size: number }>();
  previewData.packages.forEach((pkg) => {
    pkg.files.forEach((file) => {
      const ext = getFileExtension(file.path) || 'other';
      const current = fileTypes.get(ext) || { count: 0, size: 0 };
      fileTypes.set(ext, { count: current.count + 1, size: current.size + file.size });
    });
  });
  const sortedFileTypes = Array.from(fileTypes.entries()).sort((a, b) => b[1].size - a[1].size).slice(0, 6);

  const columns = [
    {
      title: 'File',
      dataIndex: 'path',
      key: 'path',
      render: (path: string) => (
        <UISpace size={4}>
          <UIIcon name="FileOutlined" style={{ color: getFileTypeColor(path) }} />
          <UITypographyText code style={{ fontSize: 12 }}>{path}</UITypographyText>
        </UISpace>
      ),
    },
    {
      title: 'Size',
      dataIndex: 'size',
      key: 'size',
      width: 100,
      align: 'right' as const,
      render: (size: number) => (
        <UITypographyText type="secondary" style={{ fontSize: 12 }}>{formatBytes(size)}</UITypographyText>
      ),
    },
  ];

  return (
    <div>
      <UICard style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <UISpace size="large">
            <div>
              <UITypographyText type="secondary" style={{ display: 'block', fontSize: 12 }}>Total Files</UITypographyText>
              <UITitle level={3} style={{ margin: 0 }}>{totalFiles}</UITitle>
            </div>
            <div>
              <UITypographyText type="secondary" style={{ display: 'block', fontSize: 12 }}>Total Size</UITypographyText>
              <UITitle level={3} style={{ margin: 0 }}>{formatBytes(totalSize)}</UITitle>
            </div>
            <div>
              <UITypographyText type="secondary" style={{ display: 'block', fontSize: 12 }}>Packages</UITypographyText>
              <UITitle level={3} style={{ margin: 0 }}>{previewData.packages.length}</UITitle>
            </div>
          </UISpace>
          <UISpace>
            {allBuilt ? (
              <UITypographyText strong style={{ color: token.colorSuccess }}>Ready to publish</UITypographyText>
            ) : (
              <UITypographyText strong style={{ color: token.colorWarning }}>Build required</UITypographyText>
            )}
          </UISpace>
        </div>

        <div style={{ marginTop: 16 }}>
          <UISpace>
            <UIButton
              variant="primary"
              icon={<UIIcon name="BuildOutlined" />}
              onClick={() => void handleBuild()}
              loading={buildLoading}
              size="small"
            >
              {buildLoading ? 'Building...' : needsBuild ? 'Build' : 'Rebuild'}
            </UIButton>
            <UIButton
              icon={<UIIcon name="ReloadOutlined" />}
              onClick={() => refetch()}
              disabled={buildLoading}
              size="small"
            >
              Refresh
            </UIButton>
          </UISpace>
          {needsBuild && (
            <UIAlert
              variant="warning"
              message="Some packages need to be built before publishing"
              style={{ marginTop: 12 }}
              showIcon
            />
          )}
        </div>

        <div style={{ marginTop: 24 }}>
          <UITypographyText type="secondary" style={{ display: 'block', marginBottom: 8, fontSize: 12 }}>
            File Types
          </UITypographyText>
          <UISpace wrap>
            {sortedFileTypes.map(([ext, stats]) => (
              <UITag key={ext} style={{ margin: 0 }}>
                <span style={{ color: getFileTypeColor(`.${ext}`) }}>.{ext}</span>
                {' '}{stats.count} ({formatBytes(stats.size)})
              </UITag>
            ))}
          </UISpace>
        </div>
      </UICard>

      {previewData.packages.map((pkg) => (
        <UICard
          key={pkg.name}
          title={
            <UISpace>
              <UIIcon name="FolderOutlined" />
              <UITypographyText strong>{pkg.name}</UITypographyText>
              <UITag color="blue">v{pkg.version}</UITag>
            </UISpace>
          }
          extra={
            <UISpace>
              {pkg.buildStatus === 'ready' ? (
                <UITag color="success">Built</UITag>
              ) : pkg.buildStatus === 'building' ? (
                <UITag color="processing">Building...</UITag>
              ) : (
                <UITag color="warning">Not built</UITag>
              )}
              <UITag>{pkg.fileCount} files</UITag>
              <UITag color="green">{formatBytes(pkg.totalSize)}</UITag>
            </UISpace>
          }
          style={{ marginBottom: 16 }}
          size="small"
        >
          <div style={{ marginBottom: 16 }}>
            <UIProgress
              percent={100}
              success={{ percent: (pkg.files.filter((f) => f.path.endsWith('.js') || f.path.endsWith('.mjs')).reduce((s, f) => s + f.size, 0) / pkg.totalSize) * 100 }}
              strokeColor={token.colorPrimary}
              trailColor={token.colorFillTertiary}
              showInfo={false}
              size="small"
            />
          </div>
          <UITable
            dataSource={pkg.files}
            columns={columns}
            rowKey="path"
            size="small"
            pagination={pkg.files.length > 10 ? { pageSize: 10 } : false}
          />
        </UICard>
      ))}
    </div>
  );
}
