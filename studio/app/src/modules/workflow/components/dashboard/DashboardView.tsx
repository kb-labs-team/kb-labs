/**
 * Dashboard view for a single workflow run.
 * Shows: StatsBar (stats + phases) → Hero block (current step) → Completed steps → Skipped steps → Future steps
 */

import * as React from 'react';
import { useElapsedTimer } from '@kb-labs/studio-hooks';
import { useState } from 'react';
import {
  UITypographyText, UISpace, UIIcon, UITag } from '@kb-labs/studio-ui-kit';
import type { WorkflowRun, StepRun, StepArtifact } from '@kb-labs/workflow-contracts';
import { PhaseProgressBar, type PhaseStatus } from '../shared/PhaseProgressBar';
import { usePipelineModel } from '../../hooks/use-pipeline-graph';
import { StatusDot } from '../pipeline/shared';
import { ArtifactViewer } from '../artifacts/ArtifactViewer';

// Runtime fields not yet in the schema — accessed via type assertion
interface StepRunRuntime extends StepRun {
  progress?: number;
  progressMessage?: string;
}

function flatSteps(run: WorkflowRun): StepRun[] {
  return run.jobs.flatMap((j) => j.steps);
}

function formatDurationMs(ms: number): string {
  if (ms < 1000) { return `${ms}ms`; }
  const s = ms / 1000;
  if (s < 60) { return `${s.toFixed(1)}s`; }
  const m = Math.floor(s / 60);
  const rem = Math.floor(s % 60);
  return `${m}m ${rem}s`;
}

// ─── Stat + phase bar ───────────────────────────────────────────────────────
// Single-row summary (stats inline + phase progress), mirroring the compact
// "pulse" bar used on the platform dashboard — keeps the header out of the way
// of the actually useful content (current/completed steps) below.

interface StatInlineProps {
  value: number | string;
  label: string;
  color?: string;
}

function StatInline({ value, label, color = 'var(--text-primary)' }: StatInlineProps) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 5, whiteSpace: 'nowrap' }}>
      <span style={{ fontSize: 15, fontWeight: 700, color, lineHeight: 1 }}>{value}</span>
      <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{label}</span>
    </span>
  );
}

interface StatsBarProps {
  allSteps: StepRun[];
  run: WorkflowRun;
  isTerminal: boolean;
  phases: PhaseStatus[];
}

function StatsBar({ allSteps, run, isTerminal, phases }: StatsBarProps) {
  const total     = allSteps.length;
  const doneCount = allSteps.filter(s => s.status === 'success').length;
  const failCount = allSteps.filter(s => s.status === 'failed').length;
  const skipCount = allSteps.filter(s => s.status === 'skipped' || s.status === 'cancelled').length;
  const durationMs = run.durationMs ?? run.result?.metrics?.timeMs;

  if (total === 0 && phases.length === 0) { return null; }

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 14,
      padding: '8px 14px',
      border: '1px solid var(--border-primary)',
      borderRadius: 8,
      background: 'var(--bg-secondary)',
      flexWrap: 'wrap',
      marginBottom: 'var(--spacing-section)',
    }}>
      {total > 0 && (
        <>
          <StatInline value={total} label="steps" />
          <StatInline value={doneCount} label="done" color="var(--success)" />
          {failCount > 0 && <StatInline value={failCount} label="failed" color="var(--error)" />}
          {skipCount > 0 && <StatInline value={skipCount} label="skipped" color="var(--text-tertiary)" />}
          {isTerminal && durationMs != null && durationMs > 0 && (
            <StatInline value={formatDurationMs(durationMs)} label="duration" />
          )}
        </>
      )}
      {total > 0 && phases.length > 0 && (
        <span style={{ width: 1, alignSelf: 'stretch', background: 'var(--border-primary)' }} />
      )}
      {phases.length > 0 && <PhaseProgressBar phases={phases} compact />}
    </div>
  );
}

// ─── Hero block ───────────────────────────────────────────────────────────────

interface HeroBlockProps {
  step: StepRun;
  onApprove?: () => void;
}

function HeroBlock({ step, onApprove }: HeroBlockProps) {
  const rt = step as StepRunRuntime;
  const isWaiting = step.status === 'waiting_approval';
  const isRunning = step.status === 'running';
  const elapsed = useElapsedTimer(isRunning || isWaiting ? step.startedAt : undefined);
  // artifacts is Record<name, StepArtifact> in contracts
  const artifactsMap = step.spec?.artifacts as Record<string, StepArtifact> | undefined;
  const artifacts = artifactsMap ? Object.values(artifactsMap) : [];

  return (
    <div style={{
      padding: '20px 24px',
      background: 'var(--bg-secondary)',
      border: '1px solid var(--border-primary)',
      borderRadius: 10,
      marginBottom: 'var(--spacing-section)',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <StatusDot status={step.status} />
        <UITypographyText style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>
          {step.spec?.summary ?? step.name}
        </UITypographyText>
        <UITypographyText className="typo-caption text-tertiary" style={{ marginLeft: 'auto' }}>
          {step.durationMs ? formatDurationMs(step.durationMs) : elapsed ? elapsed : null}
        </UITypographyText>
      </div>

      {/* Progress message */}
      {rt.progressMessage && (
        <UITypographyText className="typo-description text-secondary" style={{ marginBottom: 10, display: 'block' }}>
          {rt.progressMessage}
        </UITypographyText>
      )}

      {/* Progress bar */}
      {rt.progress != null && (
        <div style={{ marginBottom: 12 }}>
          <div style={{
            height: 6,
            background: 'var(--border-primary)',
            borderRadius: 3,
            overflow: 'hidden',
          }}>
            <div style={{
              height: '100%',
              width: `${rt.progress}%`,
              background: isWaiting ? 'var(--warning)' : 'var(--link)',
              borderRadius: 3,
              transition: 'width 0.3s ease',
            }} />
          </div>
          <UITypographyText className="typo-caption text-tertiary" style={{ marginTop: 4, display: 'block' }}>
            {rt.progress}%
          </UITypographyText>
        </div>
      )}

      {/* Artifacts */}
      {artifacts.length > 0 && step.outputs && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {artifacts.map((artifact, i) => {
            // Resolve dot-path from outputs
            const data = artifact.source.split('.').reduce<unknown>(
              (acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined),
              step.outputs,
            );
            return (
              <div key={i}>
                <UITypographyText className="typo-label text-secondary" style={{ display: 'block', marginBottom: 6 }}>
                  {artifact.label}
                </UITypographyText>
                <ArtifactViewer type={artifact.type} data={data} label={artifact.label} />
              </div>
            );
          })}
        </div>
      )}

      {/* Approval CTA */}
      {isWaiting && onApprove && (
        <div style={{ marginTop: 14 }}>
          <button
            onClick={onApprove}
            style={{
              padding: '6px 16px',
              background: 'var(--link)',
              color: 'var(--text-inverse)',
              border: 'none',
              borderRadius: 6,
              fontWeight: 600,
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            Review &amp; Decide
          </button>
        </div>
      )}

      {/* Running indicator with elapsed time */}
      {isRunning && !rt.progressMessage && (
        <UISpace className="gap-tight" style={{ marginTop: 6 }}>
          <UIIcon name="LoadingOutlined" spin style={{ color: 'var(--link)', fontSize: 13 }} />
          <UITypographyText className="typo-caption text-secondary">
            {elapsed ? `Running for ${elapsed}` : 'Running…'}
          </UITypographyText>
        </UISpace>
      )}
    </div>
  );
}

// ─── Preparing block ──────────────────────────────────────────────

function PreparingBlock({ startedAt }: { startedAt?: string }) {
  const elapsed = useElapsedTimer(startedAt);
  return (
    <div style={{
      padding: '20px 24px',
      background: 'var(--bg-secondary)',
      border: '1px solid var(--border-primary)',
      borderRadius: 10,
      marginBottom: 'var(--spacing-section)',
      position: 'relative',
      overflow: 'hidden',
    }}>
      {/* Indeterminate shimmer bar at top */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: 2,
        background: 'var(--border-primary)',
      }}>
        <div style={{
          position: 'absolute', top: 0, height: '100%', width: '40%',
          background: 'linear-gradient(90deg, transparent, var(--link), transparent)',
          animation: 'kb-prep-slide 1.6s ease-in-out infinite',
        }} />
      </div>
      <style>{`
        @keyframes kb-prep-slide {
          0%   { left: -40%; }
          100% { left: 140%; }
        }
      `}</style>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <UIIcon name="LoadingOutlined" spin style={{ color: 'var(--link)', fontSize: 14, flexShrink: 0 }} />
        <UITypographyText style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>
          Preparing execution environment
        </UITypographyText>
        {elapsed && (
          <UITypographyText className="typo-caption text-tertiary" style={{ marginLeft: 'auto' }}>
            {elapsed}
          </UITypographyText>
        )}
      </div>
      <UITypographyText className="typo-description text-secondary" style={{ display: 'block', marginTop: 6, marginLeft: 24 }}>
        Provisioning workspace, scheduling steps…
      </UITypographyText>
    </div>
  );
}

// ─── Skipped section ──────────────────────────────────────────────────────────

const SKIPPED_COLLAPSE_THRESHOLD = 5;

function SkippedSection({ steps }: { steps: StepRun[] }) {
  const [expanded, setExpanded] = useState(steps.length <= SKIPPED_COLLAPSE_THRESHOLD);
  const showToggle = steps.length > SKIPPED_COLLAPSE_THRESHOLD;
  const visibleSteps = expanded ? steps : steps.slice(0, SKIPPED_COLLAPSE_THRESHOLD);

  return (
    <div style={{ marginBottom: 'var(--spacing-section)' }}>
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          marginBottom: 8, cursor: showToggle ? 'pointer' : 'default',
        }}
        onClick={showToggle ? () => setExpanded(v => !v) : undefined}
      >
        <UITypographyText className="typo-label text-secondary">
          Skipped ({steps.length})
        </UITypographyText>
        {showToggle && (
          <span style={{
            fontSize: 10, color: 'var(--text-tertiary)',
            display: 'inline-block',
            transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform 200ms ease',
          }}>
            ▶
          </span>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {visibleSteps.map((step) => (
          <div
            key={step.id}
            style={{
              padding: '7px 12px',
              background: 'transparent',
              border: '1px solid var(--border-primary)',
              borderRadius: 6,
              opacity: 0.65,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <UIIcon
                name="MinusCircleOutlined"
                style={{ color: 'var(--text-tertiary)', fontSize: 13, flexShrink: 0 }}
              />
              <UITypographyText className="typo-body text-secondary">
                {step.spec?.summary ?? step.name}
              </UITypographyText>
              {step.status === 'cancelled' && (
                <UITag style={{ marginLeft: 'auto', fontSize: 11, opacity: 0.8 }}>cancelled</UITag>
              )}
            </div>
            {step.skipReason && (
              <UITypographyText
                className="typo-caption text-tertiary"
                style={{ display: 'block', marginTop: 3, marginLeft: 21, fontStyle: 'italic' }}
              >
                {step.skipReason}
              </UITypographyText>
            )}
          </div>
        ))}

        {showToggle && !expanded && (
          <div
            onClick={() => setExpanded(true)}
            style={{
              padding: '5px 12px',
              textAlign: 'center',
              cursor: 'pointer',
              fontSize: 12,
              color: 'var(--text-tertiary)',
              borderRadius: 6,
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = 'var(--bg-hover)' }}
            onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
          >
            Show {steps.length - SKIPPED_COLLAPSE_THRESHOLD} more
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main view ────────────────────────────────────────────────────

interface DashboardViewProps {
  run: WorkflowRun;
  onApprove?: (step: StepRun) => void;
}

export function DashboardView({ run, onApprove }: DashboardViewProps) {
  const model = usePipelineModel(run);
  const phases: PhaseStatus[] = model.phases.map((phase) => {
    const allDone = phase.steps.every((s) => s.stepRun.status === 'success');
    const anyActive = phase.steps.some(
      (s) => s.stepRun.status === 'running' || s.stepRun.status === 'waiting_approval',
    );
    return { label: phase.label, status: allDone ? 'done' : anyActive ? 'active' : 'pending' };
  });

  const allSteps = flatSteps(run);

  const isRunActive = run.status === 'running' || run.status === 'queued';
  const isTerminal  = !isRunActive;

  const currentStep = allSteps.find(
    (s) => s.status === 'running' || s.status === 'waiting_approval',
  );
  const completedSteps = allSteps.filter((s) => s.status === 'success');
  const failedSteps    = allSteps.filter((s) => s.status === 'failed');
  const skippedSteps   = allSteps.filter((s) => s.status === 'skipped' || s.status === 'cancelled');
  const futureSteps    = allSteps.filter(
    (s) => s.status === 'queued',
  );

  // Show preparing state when run is active but no step has started yet
  const isPreparing = isRunActive && !currentStep && completedSteps.length === 0;

  return (
    <div>
      {/* Stat + phase summary */}
      <StatsBar allSteps={allSteps} run={run} isTerminal={isTerminal} phases={phases} />

      {/* Preparing: run active but no step started yet */}
      {isPreparing && <PreparingBlock startedAt={run.startedAt} />}

      {/* Hero: current step */}
      {currentStep && (
        <HeroBlock
          step={currentStep}
          onApprove={onApprove ? () => onApprove(currentStep) : undefined}
        />
      )}

      {/* Completed steps */}
      {completedSteps.length > 0 && (
        <div style={{ marginBottom: 'var(--spacing-section)' }}>
          <UITypographyText className="typo-label text-secondary" style={{ display: 'block', marginBottom: 8 }}>
            Completed ({completedSteps.length})
          </UITypographyText>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {completedSteps.map((step) => (
              <div
                key={step.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '8px 12px',
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border-primary)',
                  borderRadius: 6,
                }}
              >
                <UIIcon name="CheckCircleOutlined" style={{ color: 'var(--success)', fontSize: 13 }} />
                <UITypographyText className="typo-body">
                  {step.spec?.summary ?? step.name}
                </UITypographyText>
                {step.durationMs && (
                  <UITypographyText className="typo-caption text-tertiary" style={{ marginLeft: 'auto' }}>
                    {formatDurationMs(step.durationMs)}
                  </UITypographyText>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Failed steps */}
      {failedSteps.length > 0 && (
        <div style={{ marginBottom: 'var(--spacing-section)' }}>
          <UITypographyText className="typo-label text-secondary" style={{ display: 'block', marginBottom: 8 }}>
            Failed ({failedSteps.length})
          </UITypographyText>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {failedSteps.map((step) => (
              <div
                key={step.id}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 8,
                  padding: '8px 12px',
                  background: 'color-mix(in srgb, var(--error) 5%, var(--bg-secondary))',
                  border: '1px solid color-mix(in srgb, var(--error) 25%, transparent)',
                  borderRadius: 6,
                }}
              >
                <UIIcon name="CloseCircleOutlined" style={{ color: 'var(--error)', fontSize: 13, flexShrink: 0, paddingTop: 2 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <UITypographyText className="typo-body" style={{ fontWeight: 500 }}>
                    {step.spec?.summary ?? step.name}
                  </UITypographyText>
                  {step.error?.message && (
                    <UITypographyText
                      className="typo-caption"
                      style={{
                        display: 'block', marginTop: 3,
                        color: 'var(--error)', opacity: 0.85,
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                      }}
                    >
                      {(step.error.message.split('\n')[0] ?? '').slice(0, 120)}
                    </UITypographyText>
                  )}
                </div>
                {step.durationMs && (
                  <UITypographyText className="typo-caption text-tertiary" style={{ marginLeft: 'auto', flexShrink: 0 }}>
                    {formatDurationMs(step.durationMs)}
                  </UITypographyText>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Skipped / cancelled steps */}
      {skippedSteps.length > 0 && (
        <SkippedSection steps={skippedSteps} />
      )}

      {/* Future steps */}
      {futureSteps.length > 0 && (
        <div>
          <UITypographyText className="typo-label text-secondary" style={{ display: 'block', marginBottom: 8 }}>
            Upcoming ({futureSteps.length})
          </UITypographyText>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {futureSteps.map((step) => (
              <div
                key={step.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '8px 12px',
                  background: 'transparent',
                  border: '1px dashed var(--border-primary)',
                  borderRadius: 6,
                  opacity: 0.5,
                }}
              >
                <UIIcon name="ClockCircleOutlined" style={{ color: 'var(--text-tertiary)', fontSize: 13 }} />
                <UITypographyText className="typo-body text-secondary">
                  {step.spec?.summary ?? step.name}
                </UITypographyText>
                {step.spec?.phase && (
                  <UITag style={{ marginLeft: 'auto', opacity: 0.7 }}>{step.spec.phase}</UITag>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Empty state */}
      {!currentStep && completedSteps.length === 0 && failedSteps.length === 0 && futureSteps.length === 0 && skippedSteps.length === 0 && (
        <div style={{ textAlign: 'center', padding: '40px 0' }}>
          <UITypographyText className="typo-description text-secondary">
            No execution data
          </UITypographyText>
        </div>
      )}
    </div>
  );
}
