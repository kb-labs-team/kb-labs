/**
 * Step 4: Pre-checks, OTP input, publish, and rollback
 */

import * as React from 'react';
import {
  UIButton,
  UICard,
  UISpace,
  UITypographyText,
  UIAlert,
  UIInput,
  UIResult,
  UIAccordion,
  UITag,
  UIBadge,
  UIPopconfirm,
  UIDivider,
  UIMessage,
  UIIcon,
  UISkeleton,
} from '@kb-labs/sdk/studio';
import { useData, useMutateData, useTheme } from '@kb-labs/sdk/studio';
import type {
  PlanResponse,
  GetChecksResponse,
  RunChecksRequest,
  RunChecksResponse,
  RunReleaseRequest,
  RunReleaseResponse,
  ResetPlanRequest,
  ResetPlanResponse,
} from '../../../contracts/index.js';

type CheckStatus = 'pending' | 'running' | 'success' | 'error';

interface PreCheck {
  id: string;
  name: string;
  status: CheckStatus;
  error?: string;
  duration?: number;
  optional?: boolean;
}

interface ReleaseStepProps {
  selectedScope: string;
  onReleaseComplete: () => void;
}

export function ReleaseStep({ selectedScope, onReleaseComplete }: ReleaseStepProps) {
  const { antdToken: token } = useTheme();
  const [otp, setOtp] = React.useState('');
  const [otpError, setOtpError] = React.useState('');
  const [checks, setChecks] = React.useState<PreCheck[]>([]);
  const [checksComplete, setChecksComplete] = React.useState(false);
  const [checksRunning, setChecksRunning] = React.useState(false);
  const [releaseStarted, setReleaseStarted] = React.useState(false);
  const [releaseComplete, setReleaseComplete] = React.useState(false);
  const [releaseError, setReleaseError] = React.useState<string | null>(null);

  const planUrl = selectedScope ? `/v1/plugins/release/plan?scope=${encodeURIComponent(selectedScope)}` : '';
  const checksUrl = selectedScope ? `/v1/plugins/release/checks?scope=${encodeURIComponent(selectedScope)}` : '';

  const { data: planData } = useData<PlanResponse>(planUrl);
  const { data: checksConfig, isLoading: checksConfigLoading } = useData<GetChecksResponse>(checksUrl);

  const { mutateAsync: runChecks } = useMutateData<RunChecksRequest, RunChecksResponse>('/v1/plugins/release/checks/run', 'POST');
  const { mutateAsync: runRelease, isLoading: releaseLoading } = useMutateData<RunReleaseRequest, RunReleaseResponse>('/v1/plugins/release/run', 'POST');
  const { mutateAsync: rollback, isLoading: rollbackLoading } = useMutateData<ResetPlanRequest, ResetPlanResponse>('/v1/plugins/release/plan', 'DELETE');

  React.useEffect(() => {
    if (checksConfig && !checksComplete && !checksRunning && checks.length === 0) {
      setChecks(checksConfig.checks.map((c) => ({
        id: c.id,
        name: c.name,
        status: 'pending' as const,
        optional: c.optional,
      })));
    }
  }, [checksConfig, checksComplete, checksRunning, checks.length]);

  const allChecksPassed = checks.length > 0 && checks.every((c) => c.status === 'success');
  const anyCheckFailed = checks.some((c) => c.status === 'error');

  const runPreChecks = async () => {
    setChecksRunning(true);
    setChecksComplete(false);
    setChecks((prev) => prev.map((c) => ({ ...c, status: 'running' as const, error: undefined, duration: undefined })));
    try {
      const result = await runChecks({ scope: selectedScope });
      setChecks((prev) => {
        const resultById = new Map(result.checks.map((c) => [c.id, c]));
        return prev.map((c) => {
          const r = resultById.get(c.id);
          if (!r) { return { ...c, status: 'pending' as const }; }
          return { ...c, status: r.success ? 'success' as const : 'error' as const, error: r.error, duration: r.durationMs };
        });
      });
      setChecksComplete(result.success);
      if (!result.success) { UIMessage.error('Some checks failed'); }
    } catch (error) {
      setChecks((prev) => prev.map((c) => ({ ...c, status: 'pending' as const })));
      UIMessage.error(`Checks failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setChecksRunning(false);
    }
  };

  const validateOtp = (): boolean => {
    if (otp && !/^\d{6}$/.test(otp)) {
      setOtpError('OTP must be 6 digits');
      return false;
    }
    setOtpError('');
    return true;
  };

  const handleRunRelease = async () => {
    if (!validateOtp()) { return; }
    setReleaseStarted(true);
    setReleaseError(null);
    try {
      const result = await runRelease({ scope: selectedScope, dryRun: false, otp });
      if (result.success) {
        setReleaseComplete(true);
        UIMessage.success('Release published successfully!');
        onReleaseComplete();
      } else {
        const errorMessage = result.errors?.join(', ') || 'Unknown publish error';
        setReleaseError(errorMessage);
        setReleaseStarted(false);
        UIMessage.error(`Release failed: ${errorMessage}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      setReleaseError(errorMessage);
      setReleaseStarted(false);
      UIMessage.error(`Release failed: ${errorMessage}`);
    }
  };

  const handleRollback = async () => {
    try {
      await rollback({ scope: selectedScope });
      UIMessage.success('Rollback completed successfully');
      setReleaseComplete(false);
      setReleaseStarted(false);
      setReleaseError(null);
      setChecksComplete(false);
      setChecks((prev) => prev.map((c) => ({ ...c, status: 'pending' as const, error: undefined, duration: undefined })));
    } catch (error) {
      UIMessage.error(`Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const resetChecks = () => {
    setChecks((prev) => prev.map((c) => ({ ...c, status: 'pending' as const, error: undefined, duration: undefined })));
    setChecksComplete(false);
  };

  const getCheckStatusIcon = (status: CheckStatus) => {
    switch (status) {
      case 'running': return <UIIcon name="LoadingOutlined" style={{ color: token.colorPrimary }} />;
      case 'success': return <UIIcon name="CheckCircleOutlined" style={{ color: token.colorSuccess }} />;
      case 'error': return <UIIcon name="CloseCircleOutlined" style={{ color: token.colorError }} />;
      default: return <UIIcon name="SafetyCertificateOutlined" style={{ color: token.colorTextTertiary }} />;
    }
  };

  const checkCardStatus = (status: CheckStatus): 'default' | 'success' | 'error' => {
    if (status === 'success') { return 'success'; }
    if (status === 'error') { return 'error'; }
    return 'default';
  };

  if (releaseComplete) {
    return (
      <UICard>
        <UIResult
          status="success"
          title="Release Published!"
          subTitle={`${planData?.plan?.packages.length ?? 0} package(s) published to npm`}
          extra={[
            <UIPopconfirm
              key="rollback"
              title="Rollback Release"
              description="This will unpublish the packages. Are you sure?"
              icon={<UIIcon name="ExclamationCircleOutlined" style={{ color: '#ff4d4f' }} />}
              onConfirm={() => void handleRollback()}
              okText="Yes, Rollback"
              okButtonProps={{ danger: true }}
              cancelText="Cancel"
            >
              <UIButton icon={<UIIcon name="RollbackOutlined" />} loading={rollbackLoading} danger>
                Rollback
              </UIButton>
            </UIPopconfirm>,
          ]}
        />
      </UICard>
    );
  }

  return (
    <div>
      <UICard
        title={
          <UISpace>
            <span>Pre-release Checks</span>
            {allChecksPassed && <UIBadge variant="success">All Passed</UIBadge>}
            {anyCheckFailed && <UIBadge variant="error">Failed</UIBadge>}
          </UISpace>
        }
        style={{ marginBottom: 16 }}
      >
        <UISpace direction="vertical" style={{ width: '100%' }} size="middle">
          {checksConfigLoading && checks.length === 0 && <UISkeleton active lines={4} title={false} />}
          {!checksConfigLoading && checks.length === 0 && (
            <UITypographyText type="secondary">No checks configured in kb.config.json release.checks</UITypographyText>
          )}
          {checks.map((check) => (
            <UICard key={check.id} size="small" status={checkCardStatus(check.status)}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <UISpace>
                  {getCheckStatusIcon(check.status)}
                  <div>
                    <UISpace>
                      <UITypographyText strong>{check.name}</UITypographyText>
                      {check.optional && <UITag>optional</UITag>}
                    </UISpace>
                    {check.error && (
                      <div style={{ marginTop: 4 }}>
                        <pre style={{
                          margin: 0, padding: '8px 12px', fontSize: 11, lineHeight: 1.5,
                          color: token.colorError, background: token.colorErrorBg, borderRadius: token.borderRadiusSM,
                          maxHeight: 200, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                        }}>
                          {check.error}
                        </pre>
                      </div>
                    )}
                  </div>
                </UISpace>
                {check.duration && <UITag>{(check.duration / 1000).toFixed(1)}s</UITag>}
              </div>
            </UICard>
          ))}
          <div style={{ display: 'flex', gap: 8 }}>
            <UIButton
              variant="primary"
              icon={<UIIcon name="BuildOutlined" />}
              onClick={() => void runPreChecks()}
              loading={checksRunning}
              disabled={checksComplete}
            >
              {checksRunning ? 'Running Checks...' : 'Run Checks'}
            </UIButton>
            {(checksComplete || anyCheckFailed) && (
              <UIButton onClick={resetChecks}>Reset</UIButton>
            )}
          </div>
        </UISpace>
      </UICard>

      <UICard title="npm Publish">
        {!allChecksPassed && (
          <UIAlert
            message="Complete pre-release checks first"
            description="All checks must pass before you can publish to npm."
            variant="info"
            showIcon
            style={{ marginBottom: 16 }}
          />
        )}
        {releaseError && (
          <UIAlert
            message="Release Failed"
            description={releaseError}
            variant="error"
            showIcon
            closable
            onClose={() => setReleaseError(null)}
            style={{ marginBottom: 16 }}
          />
        )}
        <UISpace direction="vertical" style={{ width: '100%' }} size="middle">
          {planData?.plan && (
            <UIAccordion
              size="small"
              items={[{
                key: 'summary',
                label: 'Release Summary',
                extra: <UITag color="blue">{planData.plan.packages.length} package(s)</UITag>,
                children: (
                  <div>
                    {planData.plan.packages.map((pkg) => (
                      <div key={pkg.name} style={{ marginBottom: 4 }}>
                        <UITypographyText code>{pkg.name}</UITypographyText>
                        <UITypographyText type="secondary"> {pkg.currentVersion} → </UITypographyText>
                        <UITypographyText strong style={{ color: '#52c41a' }}>{pkg.nextVersion}</UITypographyText>
                      </div>
                    ))}
                  </div>
                ),
              }]}
            />
          )}
          <UIDivider style={{ margin: '8px 0' }} />
          <div>
            <UITypographyText strong style={{ display: 'block', marginBottom: 8 }}>
              npm One-Time Password (OTP){' '}
              <UITypographyText type="secondary" style={{ fontWeight: 'normal' }}>— optional</UITypographyText>
            </UITypographyText>
            <UITypographyText type="secondary" style={{ display: 'block', marginBottom: 8, fontSize: 12 }}>
              Required only if your npm account uses 2FA. Leave empty to publish via NPM_TOKEN.
            </UITypographyText>
            <UIInput
              prefix={<UIIcon name="LockOutlined" />}
              placeholder="123456"
              value={otp}
              onChange={(value) => { setOtp(value.replace(/\D/g, '').slice(0, 6)); setOtpError(''); }}
              maxLength={6}
              style={{ width: 200, fontSize: 18, letterSpacing: 8 }}
              status={otpError ? 'error' : undefined}
              disabled={!allChecksPassed || releaseStarted}
            />
            {otpError && (
              <UITypographyText type="danger" style={{ display: 'block', marginTop: 4, fontSize: 12 }}>
                {otpError}
              </UITypographyText>
            )}
          </div>
          <UIDivider style={{ margin: '8px 0' }} />
          <UIButton
            variant="primary"
            size="large"
            icon={<UIIcon name="RocketOutlined" />}
            onClick={() => void handleRunRelease()}
            loading={releaseLoading}
            disabled={!allChecksPassed || releaseStarted}
            block
          >
            Publish to npm
          </UIButton>
          <UITypographyText type="secondary" style={{ textAlign: 'center', display: 'block', fontSize: 12 }}>
            This action will publish packages to the npm registry
          </UITypographyText>
        </UISpace>
      </UICard>
    </div>
  );
}
