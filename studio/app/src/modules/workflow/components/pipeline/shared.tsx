/**
 * Shared pipeline visualization utilities.
 * Extracted from PipelineView for reuse across views.
 */

// ─── CSS injection ───────────────────────────────────────────────────────────

const ANIM_CSS = `
@keyframes kb-spin    { 0% { transform: rotate(0deg) } 100% { transform: rotate(360deg) } }
@keyframes kb-shimmer { 0% { left: -60% } 100% { left: 120% } }
`
let injected = false
export function injectCss() {
  if (injected || typeof document === 'undefined') {return}
  injected = true
  const s = document.createElement('style')
  s.textContent = ANIM_CSS
  document.head.appendChild(s)
}

// ─── Status mappings ─────────────────────────────────────────────────────────

export const S_COLOR: Record<string, string> = {
  queued:           'var(--text-tertiary)',
  running:          'var(--warning)',
  success:          'var(--success)',
  failed:           'var(--error)',
  cancelled:        'var(--text-tertiary)',
  skipped:          'var(--text-tertiary)',
  waiting_approval: 'var(--info)',
}

export const S_LABEL: Record<string, string> = {
  queued:           'Queued',
  running:          'Running',
  success:          'Done',
  failed:           'Failed',
  cancelled:        'Cancelled',
  skipped:          'Skipped',
  waiting_approval: 'Review',
}

export const PHASE_COLOR: Record<string, string> = {
  Planning:       'var(--info)',
  Implementation: 'var(--success)',
  Quality:        'var(--warning)',
  Delivery:       'var(--link)',
}

// ─── StatusDot ───────────────────────────────────────────────────────────────

export function StatusDot({ status }: { status: string }) {
  injectCss()
  const color = S_COLOR[status] ?? 'var(--text-tertiary)'
  if (status === 'running') {
    return <span style={{
      display: 'inline-block', width: 8, height: 8, flexShrink: 0,
      border: `2px solid ${color}`, borderTopColor: 'transparent',
      borderRadius: '50%', animation: 'kb-spin 0.8s linear infinite',
    }} />
  }
  const filled = status === 'success' || status === 'failed' || status === 'waiting_approval'
  return <span style={{
    display: 'inline-block', width: 8, height: 8, flexShrink: 0,
    borderRadius: '50%',
    background: filled ? color : 'transparent',
    border: `2px solid ${color}`,
  }} />
}

// ─── formatDuration ──────────────────────────────────────────────────────────

export function formatDuration(ms?: number) {
  if (!ms) {return null}
  if (ms < 1000) {return `${ms}ms`}
  const s = ms / 1000
  if (s < 60) {return `${s.toFixed(1)}s`}
  return `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`
}
