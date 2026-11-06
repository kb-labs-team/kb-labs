/**
 * Board (kanban) view for workflow runs.
 * Columns: Queued → Running → Waiting Approval → Success → Failed → Cancelled
 */

import { UITypographyText } from '@kb-labs/studio-ui-kit';
import type { WorkflowRun } from '@kb-labs/workflow-contracts';
import { RunCard } from '../triage/RunCard';

const COLUMNS: { status: WorkflowRun['status'] | 'waiting_approval'; label: string; color: string }[] = [
  { status: 'queued',           label: 'Queued',           color: 'var(--text-tertiary)' },
  { status: 'running',          label: 'Running',          color: 'var(--info)' },
  { status: 'waiting_approval', label: 'Waiting Approval', color: 'var(--warning)' },
  { status: 'success',          label: 'Success',          color: 'var(--success)' },
  { status: 'failed',           label: 'Failed',           color: 'var(--error)' },
  { status: 'dlq',              label: 'Dead Letter',      color: 'var(--error)' },
  { status: 'cancelled',        label: 'Cancelled',        color: 'var(--text-tertiary)' },
];

interface BoardViewProps {
  runs: WorkflowRun[];
  onRunClick: (runId: string) => void;
}

export function BoardView({ runs, onRunClick }: BoardViewProps) {
  const byStatus = Object.fromEntries(
    COLUMNS.map((col) => [col.status, runs.filter((r) => r.status === col.status)]),
  );

  const activeCols = COLUMNS.filter((col) => (byStatus[col.status]?.length ?? 0) > 0);

  if (activeCols.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '48px 0' }}>
        <UITypographyText className="typo-description text-secondary">No runs found</UITypographyText>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', gap: 16, overflowX: 'auto', paddingBottom: 8 }}>
      {activeCols.map((col) => (
        <div
          key={col.status}
          style={{ minWidth: 280, maxWidth: 320, flexShrink: 0 }}
        >
          {/* Column header */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            marginBottom: 10, padding: '0 4px',
          }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: col.color, display: 'inline-block' }} />
            <UITypographyText className="typo-label" style={{ color: 'var(--text-secondary)' }}>
              {col.label}
            </UITypographyText>
            <UITypographyText className="typo-caption text-tertiary">
              {byStatus[col.status]!.length}
            </UITypographyText>
          </div>

          {/* Cards */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {byStatus[col.status]!.map((run) => (
              <RunCard key={run.id} run={run} onClick={() => onRunClick(run.id)} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
