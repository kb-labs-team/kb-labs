import type { SSEConnectionStatus } from '@kb-labs/studio-hooks'

interface ConnectionBadgeProps {
  status: SSEConnectionStatus;
  lastEventAt?: Date;
}

const DOT_STYLE: React.CSSProperties = {
  display: 'inline-block',
  width: 7,
  height: 7,
  borderRadius: '50%',
  marginRight: 5,
  flexShrink: 0,
}

const CONTAINER: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  fontSize: 12,
  fontWeight: 500,
  cursor: 'default',
  userSelect: 'none',
}

export function ConnectionBadge({ status, lastEventAt }: ConnectionBadgeProps) {
  if (status === 'closed') {return null}

  const tooltip = lastEventAt
    ? `Last update: ${Math.round((Date.now() - lastEventAt.getTime()) / 1000)}s ago`
    : undefined

  if (status === 'live') {
    return (
      <span style={{ ...CONTAINER, color: 'var(--color-success, #3fb950)' }} title={tooltip}>
        <span
          style={{
            ...DOT_STYLE,
            background: 'var(--color-success, #3fb950)',
            boxShadow: '0 0 0 0 rgba(63,185,80,0.4)',
            animation: 'kb-sse-pulse 2s ease-in-out infinite',
          }}
        />
        Live
        <style>{`
          @keyframes kb-sse-pulse {
            0%   { box-shadow: 0 0 0 0 rgba(63,185,80,0.5); }
            70%  { box-shadow: 0 0 0 5px rgba(63,185,80,0); }
            100% { box-shadow: 0 0 0 0 rgba(63,185,80,0); }
          }
        `}</style>
      </span>
    )
  }

  if (status === 'reconnecting') {
    return (
      <span style={{ ...CONTAINER, color: 'var(--color-warning, #d29922)' }} title="Reconnecting to event stream…">
        <span style={{ ...DOT_STYLE, background: 'var(--color-warning, #d29922)', opacity: 0.9 }} />
        Reconnecting…
      </span>
    )
  }

  // connecting
  return (
    <span style={{ ...CONTAINER, color: 'var(--text-tertiary, #8b949e)' }} title="Connecting to event stream…">
      <span style={{ ...DOT_STYLE, background: 'var(--text-tertiary, #8b949e)' }} />
      Connecting…
    </span>
  )
}
