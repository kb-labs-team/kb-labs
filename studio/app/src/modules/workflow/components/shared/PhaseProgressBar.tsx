/**
 * Horizontal phase progress bar.
 * Shows workflow phases as connected dots with labels.
 *
 * Example: ● Planning ━━━ ◉ Implementation ━━━ ○ Quality ━━━ ○ Delivery
 */

export interface PhaseStatus {
  label: string
  status: 'done' | 'active' | 'pending'
}

const PHASE_COLORS: Record<PhaseStatus['status'], string> = {
  done: 'var(--success)',
  active: 'var(--warning)',
  pending: 'var(--text-tertiary)',
}

function PhaseDot({ status }: { status: PhaseStatus['status'] }) {
  const color = PHASE_COLORS[status]
  const size = status === 'active' ? 10 : 8

  if (status === 'active') {
    return (
      <span style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: '50%',
        border: `2px solid ${color}`,
        background: `color-mix(in srgb, ${color} 30%, transparent)`,
        flexShrink: 0,
      }} />
    )
  }

  return (
    <span style={{
      display: 'inline-block',
      width: size,
      height: size,
      borderRadius: '50%',
      background: status === 'done' ? color : 'transparent',
      border: `2px solid ${color}`,
      flexShrink: 0,
    }} />
  )
}

interface PhaseProgressBarProps {
  phases: PhaseStatus[]
  compact?: boolean
}

export function PhaseProgressBar({ phases, compact }: PhaseProgressBarProps) {
  if (!phases.length) {return null}

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: compact ? 4 : 6,
    }}>
      {phases.map((phase, i) => {
        const isLast = i === phases.length - 1
        const lineColor = phase.status === 'done'
          ? 'var(--success)'
          : 'var(--border-primary)'

        return (
          <div key={phase.label} style={{ display: 'flex', alignItems: 'center', gap: compact ? 4 : 6 }}>
            <PhaseDot status={phase.status} />
            {!compact && (
              <span style={{
                fontSize: 11,
                fontWeight: phase.status === 'active' ? 600 : 400,
                color: PHASE_COLORS[phase.status],
                whiteSpace: 'nowrap',
              }}>
                {phase.label}
              </span>
            )}
            {!isLast && (
              <div style={{
                width: compact ? 12 : 24,
                height: 2,
                background: lineColor,
                borderRadius: 1,
                flexShrink: 0,
              }} />
            )}
          </div>
        )
      })}
    </div>
  )
}
