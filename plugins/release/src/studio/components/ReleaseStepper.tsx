/**
 * Breadcrumb-based release flow: Plan → Changelog → Preview → Release
 */

import * as React from 'react';
import { useSearchParams } from 'react-router-dom';
import { UIButton, UICard, UIResult, useTheme } from '@kb-labs/sdk/studio';
import { useMutateData } from '@kb-labs/sdk/studio';
import { PlanStep } from './steps/PlanStep';
import { ChangelogStep } from './steps/ChangelogStep';
import { PreviewStep } from './steps/PreviewStep';
import { ReleaseStep } from './steps/ReleaseStep';
import type { ResetPlanRequest, ResetPlanResponse } from '../../contracts/index.js';

type StepKey = 'plan' | 'changelog' | 'preview' | 'release';

const STEPS: Array<{ key: StepKey; title: string }> = [
  { key: 'plan', title: 'Plan' },
  { key: 'changelog', title: 'Changelog' },
  { key: 'preview', title: 'Preview' },
  { key: 'release', title: 'Release' },
];
const STEP_KEYS: StepKey[] = STEPS.map((s) => s.key);
const STEP_INDEX: Record<StepKey, number> = { plan: 0, changelog: 1, preview: 2, release: 3 };

interface ReleaseStepperProps {
  selectedScope: string;
  selectedScopePath?: string;
}

export function ReleaseStepper({ selectedScope, selectedScopePath }: ReleaseStepperProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const { antdToken: token } = useTheme();
  const { mutateAsync: resetPlan } = useMutateData<ResetPlanRequest, ResetPlanResponse>('/v1/plugins/release/plan', 'DELETE');

  const stepParam = searchParams.get('step') as StepKey | null;
  const currentStep = STEP_INDEX[stepParam as StepKey] ?? 0;

  const setCurrentStep = (index: number) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('step', STEP_KEYS[index] ?? 'plan');
      return next;
    });
  };

  const [releaseComplete, setReleaseComplete] = React.useState(false);
  const [planReady, setPlanReady] = React.useState(false);
  const [changelogReady, setChangelogReady] = React.useState(false);
  const [previewReady, setPreviewReady] = React.useState(false);

  const canGoNext = () => {
    if (currentStep === 0) { return planReady; }
    if (currentStep === 1) { return changelogReady; }
    if (currentStep === 2) { return previewReady; }
    return false;
  };

  const handleNext = () => {
    if (currentStep < STEPS.length - 1) { setCurrentStep(currentStep + 1); }
  };

  const handlePrev = () => {
    if (currentStep > 0) { setCurrentStep(currentStep - 1); }
  };

  const handleStartOver = () => {
    void resetPlan({ scope: selectedScope });
    setCurrentStep(0);
    setReleaseComplete(false);
    setPlanReady(false);
    setChangelogReady(false);
    setPreviewReady(false);
  };

  if (!selectedScope) {
    return (
      <UICard>
        <UIResult
          status="info"
          title="Select a scope"
          subTitle="Please select a package or monorepo scope to start the release process."
        />
      </UICard>
    );
  }

  if (releaseComplete) {
    return (
      <UICard>
        <UIResult
          status="success"
          title="Release Complete!"
          subTitle="Your packages have been published successfully."
          extra={[
            <UIButton key="new" variant="primary" onClick={handleStartOver}>
              Start New Release
            </UIButton>,
          ]}
        />
      </UICard>
    );
  }

  const renderStepContent = () => {
    switch (currentStep) {
      case 0: return <PlanStep selectedScope={selectedScope} selectedScopePath={selectedScopePath} onPlanReady={setPlanReady} />;
      case 1: return <ChangelogStep selectedScope={selectedScope} onChangelogReady={setChangelogReady} />;
      case 2: return <PreviewStep selectedScope={selectedScope} onPreviewReady={setPreviewReady} />;
      case 3: return <ReleaseStep selectedScope={selectedScope} onReleaseComplete={() => setReleaseComplete(true)} />;
      default: return null;
    }
  };

  return (
    <div>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 16,
        paddingBottom: 8,
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
      }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
          {STEPS.map((step, index) => {
            const isCurrent = index === currentStep;
            const isDone = index < currentStep;
            const clickable = isDone;
            return (
              <React.Fragment key={step.key}>
                {index > 0 && <span style={{ color: token.colorTextQuaternary }}>›</span>}
                <span
                  onClick={clickable ? () => setCurrentStep(index) : undefined}
                  style={{
                    color: isCurrent ? token.colorPrimary : isDone ? token.colorText : token.colorTextTertiary,
                    fontWeight: isCurrent ? 600 : 400,
                    cursor: clickable ? 'pointer' : 'default',
                  }}
                >
                  {step.title}
                </span>
              </React.Fragment>
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <UIButton variant="text" onClick={handlePrev} disabled={currentStep === 0} size="small">
            Back
          </UIButton>
          {currentStep < STEPS.length - 1 && (
            <UIButton variant="link" onClick={handleNext} disabled={!canGoNext()} size="small">
              Next
            </UIButton>
          )}
        </div>
      </div>

      {renderStepContent()}
    </div>
  );
}
