/**
 * Drawer showing per-package issues from the latest check snapshot.
 * Opens from the overview tab or can be used standalone.
 */

import * as React from 'react';
import {
  UIDrawer,
  UITable,
  UITag,
  UIInput,
  UISpace,
  UITypographyText,
  UIAlert,
  UIEmptyState,
  UISkeleton,
  UIIcon,
  UIAccordion,
  useData,
  useTheme,
} from '@kb-labs/sdk/studio';
import type { CheckSnapshot, DevkitCheckIssue } from '../../contracts/index.js';
import { QA_BASE_PATH, QA_ROUTES } from '../../contracts/index.js';

interface CheckDetailDrawerProps {
  open: boolean;
  onClose: () => void;
}

const SEVERITY_CONFIG: Record<string, { color: string; iconName: string }> = {
  error:   { color: 'error',   iconName: 'CloseCircleOutlined' },
  warning: { color: 'warning', iconName: 'WarningOutlined' },
  info:    { color: 'default', iconName: 'InfoCircleOutlined' },
};

interface FlatIssue extends DevkitCheckIssue {
  pkg: string;
}

/** Summary endpoint shape as documented in the REST API contract. */
interface SummaryResponse {
  latestRun: unknown;
  latestCheck: CheckSnapshot | null;
  latestStats: unknown;
  baseline: unknown;
}

export function CheckDetailDrawer({ open, onClose }: CheckDetailDrawerProps) {
  const { antdToken: token } = useTheme();
  const [search, setSearch] = React.useState('');

  const { data: summaryData, isLoading } = useData<SummaryResponse>(
    `${QA_BASE_PATH}${QA_ROUTES.SUMMARY}`,
  );

  const latestCheck = summaryData?.latestCheck ?? null;

  // Flatten all issues from all packages
  const allIssues: FlatIssue[] = React.useMemo(() => {
    if (!latestCheck) { return []; }
    const issues: FlatIssue[] = [];
    for (const [pkg, pkgData] of Object.entries(latestCheck.raw.packages)) {
      for (const issue of pkgData.issues ?? []) {
        issues.push({ ...issue, pkg });
      }
    }
    return issues;
  }, [latestCheck]);

  const filteredIssues = React.useMemo(() => {
    if (!search) { return allIssues; }
    const q = search.toLowerCase();
    return allIssues.filter(
      (i) =>
        i.pkg.toLowerCase().includes(q) ||
        i.check.toLowerCase().includes(q) ||
        i.message.toLowerCase().includes(q) ||
        (i.file ?? '').toLowerCase().includes(q),
    );
  }, [allIssues, search]);

  const errorCount = filteredIssues.filter(i => i.severity === 'error').length;
  const warningCount = filteredIssues.filter(i => i.severity === 'warning').length;

  const columns = [
    {
      title: 'Severity',
      dataIndex: 'severity',
      key: 'severity',
      width: 90,
      filters: [
        { text: 'Error', value: 'error' },
        { text: 'Warning', value: 'warning' },
        { text: 'Info', value: 'info' },
      ],
      onFilter: (value: unknown, record: FlatIssue) => record.severity === value,
      render: (severity: string) => {
        const cfg = SEVERITY_CONFIG[severity];
        return cfg
          ? <UITag color={cfg.color} icon={<UIIcon name={cfg.iconName} />}>{severity}</UITag>
          : <UITag>{severity}</UITag>;
      },
    },
    {
      title: 'Package',
      dataIndex: 'pkg',
      key: 'pkg',
      width: 200,
      sorter: (a: FlatIssue, b: FlatIssue) => a.pkg.localeCompare(b.pkg),
      render: (pkg: string) => (
        <UITypographyText code style={{ fontSize: token.fontSizeSM }}>{pkg}</UITypographyText>
      ),
    },
    {
      title: 'Check',
      dataIndex: 'check',
      key: 'check',
      width: 150,
      render: (check: string) => <UITag style={{ fontSize: token.fontSizeSM }}>{check}</UITag>,
    },
    {
      title: 'Message',
      dataIndex: 'message',
      key: 'message',
      render: (message: string, record: FlatIssue) => (
        <div>
          <span style={{ fontSize: token.fontSizeSM }}>{message}</span>
          {record.file && (
            <div>
              <UITypographyText type="secondary" style={{ fontSize: token.fontSizeSM }}>
                {record.file}
              </UITypographyText>
            </div>
          )}
        </div>
      ),
    },
  ];

  const expandedRowRender = (record: FlatIssue) => {
    if (!record.fix) { return null; }
    return (
      <UIAccordion
        ghost
        items={[{
          key: '1',
          label: 'Suggested fix',
          children: (
            <pre style={{
              background: token.colorFillTertiary,
              color: token.colorText,
              padding: token.paddingSM,
              borderRadius: token.borderRadius,
              fontSize: token.fontSizeSM,
              maxHeight: 200,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            }}>
              {record.fix}
            </pre>
          ),
        }]}
      />
    );
  };

  return (
    <UIDrawer
      title={
        <UISpace>
          <span>Check Issues</span>
          {errorCount > 0 && <UITag color="error">{errorCount} errors</UITag>}
          {warningCount > 0 && <UITag color="warning">{warningCount} warnings</UITag>}
        </UISpace>
      }
      placement="right"
      width={820}
      open={open}
      onClose={onClose}
    >
      {isLoading && (
        <UISkeleton active lines={5} />
      )}

      {!isLoading && !latestCheck && (
        <UIAlert
          variant="info"
          showIcon
          message="No check data available"
          description="Run 'kb qa check run --save' to generate check results."
        />
      )}

      {!isLoading && latestCheck && (
        <>
          <UIInput
            placeholder="Filter by package, check, message, or file..."
            prefix={<UIIcon name="SearchOutlined" />}
            value={search}
            onChange={(value) => setSearch(value)}
            style={{ marginBottom: token.marginMD }}
            allowClear
          />

          {filteredIssues.length === 0 ? (
            <UIEmptyState description={search ? 'No issues match your filter' : 'No issues found'} />
          ) : (
            <UITable<FlatIssue>
              dataSource={filteredIssues}
              columns={columns}
              rowKey={(record: FlatIssue, idx?: number) => `${record.pkg}-${record.check}-${idx ?? 0}`}
              size="small"
              pagination={{ pageSize: 50 }}
              expandable={{
                expandedRowRender,
                rowExpandable: (record) => !!record.fix,
              }}
            />
          )}
        </>
      )}
    </UIDrawer>
  );
}
