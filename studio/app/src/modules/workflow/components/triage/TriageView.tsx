/**
 * Triage view for workflow runs.
 * Groups runs into: Needs Attention → Running → Completed → Failed
 */

import * as React from 'react';
import { UITypographyText } from '@kb-labs/studio-ui-kit';
import type { WorkflowRun } from '@kb-labs/workflow-contracts';
import { RunCard } from './RunCard';

const GROUPS: { key: string; label: string; statuses: string[]; color: string }[] = [
  {
    key: 'attention',
    label: 'Needs Attention',
    statuses: ['waiting_approval'],
    color: 'var(--warning)',
  },
  {
    key: 'running',
    label: 'Running',
    statuses: ['running', 'queued'],
    color: 'var(--info)',
  },
  {
    key: 'success',
    label: 'Success',
    statuses: ['success'],
    color: 'var(--success)',
  },
  {
    key: 'failed',
    label: 'Failed',
    statuses: ['failed', 'dlq'],
    color: 'var(--error)',
  },
  {
    key: 'other',
    label: 'Other',
    statuses: ['cancelled', 'skipped', 'queued'],
    color: 'var(--text-tertiary)',
  },
];

interface TriageViewProps {
  runs: WorkflowRun[];
  onRunClick: (runId: string) => void;
}

export function TriageView({ runs, onRunClick }: TriageViewProps) {
  const grouped = React.useMemo(() => {
    const result: Record<string, WorkflowRun[]> = {};
    for (const group of GROUPS) {
      result[group.key] = runs.filter((r) => (group.statuses as string[]).includes(r.status));
    }
    return result;
  }, [runs]);

  const nonEmptyGroups = GROUPS.filter((g) => (grouped[g.key]?.length ?? 0) > 0);

  if (runs.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '48px 0', color: 'var(--text-secondary)' }}>
        <UITypographyText className="typo-description text-secondary">No runs found</UITypographyText>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
      {nonEmptyGroups.map((group) => (
        <div key={group.key}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: group.color, display: 'inline-block' }} />
            <UITypographyText className="typo-label" style={{ color: 'var(--text-secondary)' }}>
              {group.label}
            </UITypographyText>
            <UITypographyText className="typo-caption text-tertiary">
              ({grouped[group.key]!.length})
            </UITypographyText>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
            {grouped[group.key]!.map((run) => (
              <RunCard key={run.id} run={run} onClick={() => onRunClick(run.id)} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
