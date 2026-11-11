/**
 * Regressions tab — detect and display new failures since the previous run snapshot.
 */

import * as React from 'react';
import { UIAlert, UICard, UITag, UISkeleton, UISpace, UIEmptyState, UIIcon, UIFlex, useData, useTheme } from '@kb-labs/sdk/studio';
import type { RegressionDetection } from '../../contracts/index.js';
import { QA_BASE_PATH, QA_ROUTES } from '../../contracts/index.js';

export function RegressionsTab() {
  const { antdToken: token } = useTheme();
  const { data, isLoading } = useData<RegressionDetection>(`${QA_BASE_PATH}${QA_ROUTES.REGRESSIONS}`);

  if (isLoading) {
    return <UISkeleton active lines={5} />;
  }

  if (!data) {
    return (
      <UIAlert
        variant="info"
        showIcon
        message="Not enough data for regression detection"
        description="Need at least 2 history entries. Run 'kb qa run --save' multiple times."
      />
    );
  }

  if (!data.hasRegressions) {
    return (
      <div>
        <UIAlert
          variant="success"
          showIcon
          icon={<UIIcon name="CheckCircleOutlined" />}
          message="No regressions detected"
          description={
            <UISpace direction="vertical" size={0}>
              <span>All tasks show the same or fewer failures compared to the previous run.</span>
              <span style={{ color: token.colorTextSecondary, fontSize: token.fontSizeSM }}>
                Compared: {new Date(data.comparedAt.previous).toLocaleString()} →{' '}
                {new Date(data.comparedAt.current).toLocaleString()}
              </span>
            </UISpace>
          }
          style={{ marginBottom: token.marginLG }}
        />
        <UIEmptyState description="No regressions to display" />
      </div>
    );
  }

  return (
    <div>
      <UIAlert
        variant="error"
        showIcon
        icon={<UIIcon name="WarningOutlined" />}
        message={`${data.regressions.length} regression${data.regressions.length > 1 ? 's' : ''} detected`}
        description={
          <UISpace direction="vertical" size={0}>
            <span>The following tasks have new failures compared to the previous run.</span>
            <span style={{ fontSize: token.fontSizeSM, color: token.colorTextSecondary }}>
              Compared: {new Date(data.comparedAt.previous).toLocaleString()} →{' '}
              {new Date(data.comparedAt.current).toLocaleString()}
            </span>
          </UISpace>
        }
        style={{ marginBottom: token.marginLG }}
      />

      {data.regressions.map((reg, idx) => (
        <UICard
          key={idx}
          title={
            <UISpace>
              <UIIcon name="ExperimentOutlined" />
              <span>{reg.task}</span>
              <UITag color="error">+{reg.delta} new failure{reg.delta > 1 ? 's' : ''}</UITag>
            </UISpace>
          }
          style={{ marginBottom: token.marginMD }}
        >
          <div>
            <strong>New failures:</strong>
            <UIFlex wrap="wrap" gap={1} style={{ marginTop: token.marginXS }}>
              {reg.newFailures.map((pkg) => (
                <UITag key={pkg} color="error">
                  {pkg}
                </UITag>
              ))}
            </UIFlex>
          </div>
        </UICard>
      ))}

      <UIAlert
        variant="warning"
        showIcon
        message="Action required"
        description={
          <div>
            <p>Fix the regressions above before merging. Recommendations:</p>
            <ol style={{ margin: 0, paddingLeft: 20 }}>
              <li>Run <code>kb qa run</code> to see detailed error output</li>
              <li>Fix the failing packages</li>
              <li>Re-run <code>kb qa run --save</code> to verify fixes</li>
            </ol>
          </div>
        }
        style={{ marginTop: token.marginMD }}
      />
    </div>
  );
}
