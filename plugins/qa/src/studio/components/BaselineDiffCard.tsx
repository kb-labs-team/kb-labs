/**
 * Baseline diff card — shows new issues, fixed issues, score delta and grade delta.
 */

import * as React from 'react';
import {
  UICard,
  UITag,
  UITypographyText,
  UIAlert,
  UISpace,
  UIIcon,
  UISkeleton,
  useData,
  useTheme,
} from '@kb-labs/sdk/studio';
import type { QABaselineDiffResponse, BaselineCheckDiff, CheckIssueDiff } from '../../contracts/index.js';
import { QA_BASE_PATH, QA_ROUTES } from '../../contracts/index.js';

function isError(data: QABaselineDiffResponse): data is { error: 'no-baseline' | 'no-check' | 'no-stats' } {
  return 'error' in data;
}

function IssueList({ issues, color }: { issues: CheckIssueDiff[]; color: 'error' | 'success' | 'warning' }) {
  const { antdToken: token } = useTheme();
  const shown = issues.slice(0, 5);
  return (
    <div>
      {shown.map((issue, idx) => (
        <div key={idx} style={{ marginBottom: token.marginXXS }}>
          <UITag color={issue.severity === 'error' ? 'error' : issue.severity === 'warning' ? 'warning' : 'default'} style={{ fontSize: token.fontSizeSM }}>
            {issue.check}
          </UITag>
          <UITag style={{ fontSize: token.fontSizeSM }}>{issue.pkg}</UITag>
          <span style={{ fontSize: token.fontSizeSM, color: token.colorTextSecondary }}>{issue.message.slice(0, 60)}{issue.message.length > 60 ? '…' : ''}</span>
        </div>
      ))}
      {issues.length > 5 && (
        <UITypographyText type="secondary" style={{ fontSize: token.fontSizeSM }}>
          +{issues.length - 5} more
        </UITypographyText>
      )}
    </div>
  );
}

function DiffContent({ diff }: { diff: BaselineCheckDiff }) {
  const { antdToken: token } = useTheme();
  const hasNewIssues = diff.newIssueCount > 0;
  const hasFixed = diff.fixedIssueCount > 0;

  const scoreDeltaColor = diff.scoreDelta < 0
    ? token.colorError
    : diff.scoreDelta > 0
      ? token.colorSuccess
      : token.colorTextSecondary;

  return (
    <UICard
      title={
        <UISpace>
          <UIIcon name="WarningOutlined" style={{ color: hasNewIssues ? token.colorError : token.colorSuccess }} />
          <span>Baseline Diff</span>
          {hasNewIssues && <UITag color="error">+{diff.newIssueCount} new issues</UITag>}
          {hasFixed && <UITag color="success">{diff.fixedIssueCount} fixed</UITag>}
          <span style={{ color: scoreDeltaColor, fontWeight: 600, fontSize: 13 }}>
            {diff.scoreDelta > 0 ? '▲' : diff.scoreDelta < 0 ? '▼' : '–'} {Math.abs(diff.scoreDelta)} score
            {diff.gradeDelta ? ` (${diff.gradeDelta})` : ''}
          </span>
        </UISpace>
      }
    >
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        {/* New issues */}
        {diff.newIssues.length > 0 && (
          <div style={{ flex: '1 1 260px' }}>
            <UITypographyText type="danger" strong>New Issues ({diff.newIssues.length})</UITypographyText>
            <div style={{ marginTop: token.marginXS }}>
              <IssueList issues={diff.newIssues} color="error" />
            </div>
          </div>
        )}

        {/* Fixed issues */}
        {diff.fixedIssues.length > 0 && (
          <div style={{ flex: '1 1 260px' }}>
            <UITypographyText type="success" strong>Fixed Issues ({diff.fixedIssues.length})</UITypographyText>
            <div style={{ marginTop: token.marginXS }}>
              <IssueList issues={diff.fixedIssues} color="success" />
            </div>
          </div>
        )}
      </div>
    </UICard>
  );
}

export function BaselineDiffCard() {
  const { data: diffData, isLoading } = useData<QABaselineDiffResponse>(`${QA_BASE_PATH}${QA_ROUTES.BASELINE_DIFF}`);

  if (isLoading) { return <UISkeleton active lines={4} />; }

  if (!diffData) { return null; }

  if (isError(diffData)) {
    if (diffData.error === 'no-baseline') {
      return (
        <UIAlert
          variant="warning"
          showIcon
          message="No baseline set"
          description="Run QA checks and save a baseline to enable diff tracking."
        />
      );
    }
    if (diffData.error === 'no-check') {
      return (
        <UIAlert
          variant="info"
          showIcon
          message="No check snapshot"
          description="Run 'kb qa check run --save' to generate a check snapshot."
        />
      );
    }
    return (
      <UIAlert
        variant="info"
        showIcon
        message="No stats snapshot"
        description="Run 'kb qa stats show --save' to generate a stats snapshot."
      />
    );
  }

  const hasChanges = diffData.newIssueCount > 0 || diffData.fixedIssueCount > 0;

  if (!hasChanges) {
    return (
      <UIAlert
        variant="success"
        showIcon
        icon={<UIIcon name="CheckCircleOutlined" />}
        message="No changes since baseline"
        description={`Score delta: ${diffData.scoreDelta >= 0 ? '+' : ''}${diffData.scoreDelta}${diffData.gradeDelta ? ` (grade: ${diffData.gradeDelta})` : ''}`}
      />
    );
  }

  return <DiffContent diff={diffData} />;
}
