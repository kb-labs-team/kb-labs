/**
 * Compact run card for triage/board views.
 * Shows workflow name, task, current status, phase progress, and duration.
 */

import * as React from 'react';
import { UITag } from '@kb-labs/studio-ui-kit';
import type { WorkflowRun } from '@kb-labs/workflow-contracts';
import { StatusDot, formatDuration } from '../pipeline/shared';
import { PhaseProgressBar } from '../shared/PhaseProgressBar';
import { usePipelineModel } from '../../hooks/use-pipeline-graph';
import type { PhaseStatus } from '../shared/PhaseProgressBar';

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diffMs / 60_000);
  if (m < 1) { return 'just now'; }
  if (m < 60) { return `${m}m ago`; }
  const h = Math.floor(m / 60);
  if (h < 24) { return `${h}h ago`; }
  return `${Math.floor(h / 24)}d ago`;
}

const STATUS_TAG: Record<string, { color: string; label: string }> = {
  failed:           { color: 'error',   label: 'Failed' },
  waiting_approval: { color: 'warning', label: 'Approval' },
  running:          { color: 'processing', label: 'Running' },
  queued:           { color: 'default', label: 'Queued' },
  success:          { color: 'success', label: 'Done' },
  cancelled:        { color: 'default', label: 'Cancelled' },
};

function getCurrentStepInfo(run: WorkflowRun): { name: string; summary?: string; status: string } | null {
  for (const job of run.jobs) {
    for (const step of job.steps) {
      if (step.status === 'running' || step.status === 'waiting_approval') {
        return {
          name: step.name,
          summary: step.spec?.summary,
          status: step.status,
        };
      }
    }
  }
  return null;
}

function getTaskDescription(run: WorkflowRun): string {
  const payload = run.trigger?.payload;
  if (payload?.task && typeof payload.task === 'string') { return payload.task; }
  return '';
}

interface RunCardProps {
  run: WorkflowRun;
  onClick: () => void;
}

export function RunCard({ run, onClick }: RunCardProps) {
  const model = usePipelineModel(run);
  const phases: PhaseStatus[] = model.phases.map((phase) => {
    const allDone = phase.steps.every((s) => s.stepRun.status === 'success');
    const anyActive = phase.steps.some(
      (s) => s.stepRun.status === 'running' || s.stepRun.status === 'waiting_approval',
    );
    return {
      label: phase.label,
      status: allDone ? 'done' as const : anyActive ? 'active' as const : 'pending' as const,
    };
  });

  const currentStep = getCurrentStepInfo(run);
  const task = getTaskDescription(run);
  const startedAt = run.startedAt ?? run.jobs[0]?.startedAt ?? run.queuedAt ?? null;
  const finishedAt = run.finishedAt ?? run.jobs[0]?.finishedAt ?? null;

  const duration = startedAt
    ? formatDuration(
        (finishedAt ? new Date(finishedAt).getTime() : Date.now()) -
        new Date(startedAt).getTime(),
      )
    : null;

  const statusTag = STATUS_TAG[run.status];
  const startedAgo = startedAt ? timeAgo(startedAt) : null;

  return (
    <div
      onClick={onClick}
      style={{
        padding: '12px 16px',
        background: 'var(--bg-primary)',
        border: '1px solid var(--border-primary)',
        borderRadius: 8,
        cursor: 'pointer',
        transition: 'border-color 0.15s',
      }}
      onMouseEnter={(e: React.MouseEvent<HTMLDivElement>) => (e.currentTarget.style.borderColor = 'var(--link)')}
      onMouseLeave={(e: React.MouseEvent<HTMLDivElement>) => (e.currentTarget.style.borderColor = 'var(--border-primary)')}
    >
      {/* Header: name + status tag */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {run.name}
        </span>
        {statusTag && (
          <UITag color={statusTag.color} style={{ marginLeft: 8, flexShrink: 0 }}>{statusTag.label}</UITag>
        )}
      </div>

      {/* Meta: time ago + duration */}
      <div style={{ display: 'flex', gap: 12, marginBottom: task || phases.length > 0 || currentStep ? 8 : 0 }}>
        {startedAgo && (
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{startedAgo}</span>
        )}
        {duration && (
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{duration}</span>
        )}
        <span style={{ fontSize: 12, color: 'var(--text-tertiary)', fontFamily: 'monospace' }}>
          #{run.id.slice(-6)}
        </span>
      </div>

      {/* Task description */}
      {task && (
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {task}
        </div>
      )}

      {/* Phase progress */}
      {phases.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <PhaseProgressBar phases={phases} compact />
        </div>
      )}

      {/* Current step */}
      {currentStep && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <StatusDot status={currentStep.status} />
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            {currentStep.summary ?? currentStep.name}
          </span>
        </div>
      )}

      {/* Error summary for failed runs */}
      {run.status === 'failed' && run.result?.error && (
        <div style={{
          fontSize: 12, color: 'var(--error)', marginTop: 6,
          padding: '4px 8px', background: 'color-mix(in srgb, var(--error) 6%, transparent)',
          borderRadius: 4,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {run.result.error.message}
        </div>
      )}
    </div>
  );
}
