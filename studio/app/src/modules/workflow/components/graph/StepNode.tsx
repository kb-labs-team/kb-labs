/**
 * Custom reactflow node for a single step in the Graph view.
 * Reuses the status-color language from PipelineView.tsx so the two views
 * never disagree about what a given status looks like.
 */

import { Handle, Position, type NodeProps } from 'reactflow'
import type { WorkflowGraphNodeData } from '../../hooks/use-workflow-graph'

// Kept identical to PipelineView.tsx's S_COLOR — do not diverge.
const S_COLOR: Record<string, string> = {
  queued:           'var(--text-tertiary)',
  running:          'var(--warning)',
  success:          'var(--success)',
  failed:           'var(--error)',
  cancelled:        'var(--text-tertiary)',
  skipped:          'var(--text-tertiary)',
  waiting_approval: 'var(--info)',
}

const S_LABEL: Record<string, string> = {
  queued:           'Queued',
  running:          'Running',
  success:          'Done',
  failed:           'Failed',
  cancelled:        'Cancelled',
  skipped:          'Skipped',
  waiting_approval: 'Review',
}

function formatDuration(ms?: number): string | null {
  if (!ms) {return null}
  if (ms < 1000) {return `${ms}ms`}
  const s = ms / 1000
  if (s < 60) {return `${s.toFixed(1)}s`}
  return `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`
}

const NODE_WIDTH = 220

export function StepNode({ data }: NodeProps<WorkflowGraphNodeData>) {
  const { stepRun, nodeType, blockId, iterations, maxIterations, branchCount } = data
  const status = stepRun.status
  const color = S_COLOR[status] ?? 'var(--text-tertiary)'
  const isActive = status === 'running' || status === 'waiting_approval'
  const isSkipped = status === 'skipped' || status === 'cancelled'
  const isGate = nodeType === 'gate'
  const isApproval = nodeType === 'approval'
  const hasBranches = isGate && (branchCount ?? 0) > 0

  return (
    <div
      title={
        hasBranches
          ? `${branchCount} alternate route${branchCount === 1 ? '' : 's'} — hover to see them`
          : (isSkipped && stepRun.skipReason ? stepRun.skipReason : undefined)
      }
      style={{
        cursor: hasBranches ? 'help' : undefined,
        width: NODE_WIDTH,
        padding: '10px 12px',
        borderRadius: 8,
        background: 'var(--bg-secondary)',
        border: `1.5px solid ${color}`,
        borderStyle: isSkipped ? 'dashed' : 'solid',
        // Conditional-block membership shown as a left accent, not a lane
        // offset — keeps every node on one vertical spine.
        borderLeft: blockId ? '4px solid var(--info)' : undefined,
        opacity: isSkipped ? 0.6 : 1,
        boxShadow: isActive
          ? '0 0 0 3px color-mix(in srgb, var(--link) 35%, transparent)'
          : 'none',
      }}
    >
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />

      {/* Dedicated side handles for restartFrom/skipTo arcs, kept separate
          from the top/bottom spine handles above. An arc that enters through
          the top handle has to hook around the card's corner to get there,
          clipping through it on the way — anchoring both ends of every arc
          to the right edge instead means the whole curve lives to the right
          of the card column and can never cross over a card, by construction. */}
      <Handle type="source" id="arc-source" position={Position.Right} style={{ opacity: 0, top: '50%' }} />
      <Handle type="target" id="arc-target" position={Position.Right} style={{ opacity: 0, top: '50%' }} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
        <span style={{
          display: 'inline-block', width: 7, height: 7, borderRadius: '50%',
          background: status === 'success' || status === 'failed' || status === 'waiting_approval' ? color : 'transparent',
          border: `2px solid ${color}`,
          flexShrink: 0,
        }} />
        {isGate && <span style={{ fontSize: 11, flexShrink: 0 }}>◆</span>}
        {isApproval && <span style={{ color: 'var(--info)', flexShrink: 0, fontSize: 12 }}>⏸</span>}
        <span style={{
          fontSize: 13,
          fontWeight: 500,
          color: 'var(--text-primary)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {stepRun.name}
        </span>
        {hasBranches && (
          <span style={{
            fontSize: 10, fontWeight: 600, color: 'var(--text-tertiary)',
            background: 'var(--bg-tertiary)', borderRadius: 8,
            padding: '1px 6px', flexShrink: 0,
          }}>
            ⑂ {branchCount}
          </span>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
        <span style={{ fontSize: 11, color }}>
          {S_LABEL[status] ?? status}
        </span>
        {formatDuration(stepRun.durationMs) && (
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
            {formatDuration(stepRun.durationMs)}
          </span>
        )}
      </div>

      {isGate && maxIterations !== undefined && (
        <div style={{
          marginTop: 4, fontSize: 11, fontWeight: 600, color: 'var(--warning)',
        }}>
          ↩ {iterations ?? 0}/{maxIterations}
        </div>
      )}

      {isSkipped && stepRun.skipReason && (
        <div style={{
          marginTop: 4, fontSize: 11, color: 'var(--text-tertiary)', fontStyle: 'italic',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {stepRun.skipReason}
        </div>
      )}
    </div>
  )
}
