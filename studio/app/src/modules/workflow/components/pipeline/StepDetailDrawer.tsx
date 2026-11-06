/**
 * Drawer that shows step details when a node is clicked in PipelineView.
 * Reuses the existing StepPanel logic inline to avoid circular imports.
 */

import { useMemo, useRef, useEffect } from 'react'
import { UIDrawer, UIButton, UITabs, UIJsonViewer, UITypographyText } from '@kb-labs/studio-ui-kit';
import type { UITabItem } from '@kb-labs/studio-ui-kit';
import type { StepRun } from '@kb-labs/workflow-contracts'
import type { WorkflowLogEvent } from '@kb-labs/workflow-contracts/rest-api'

const Text = UITypographyText

const STATUS_LABEL: Record<string, string> = {
  queued:           'Queued',
  running:          'Running...',
  success:          'Completed',
  failed:           'Failed',
  cancelled:        'Cancelled',
  skipped:          'Skipped',
  waiting_approval: 'Waiting for your decision',
}

const STATUS_COLOR: Record<string, string> = {
  queued:           'var(--text-tertiary)',
  running:          'var(--warning)',
  success:          'var(--success)',
  failed:           'var(--error)',
  cancelled:        'var(--text-tertiary)',
  skipped:          'var(--text-tertiary)',
  waiting_approval: 'var(--info)',
}

function formatDuration(ms?: number): string | null {
  if (!ms) {return null}
  if (ms < 1000) {return `${ms}ms`}
  const s = ms / 1000
  if (s < 60) {return `${s.toFixed(1)}s`}
  return `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`
}

interface LogLine { time: string; text: string; stream?: 'stdout' | 'stderr' }

// Strip ANSI escape codes from text
 
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]|\x1b\].*?\x07/g
function stripAnsi(s: string): string { return s.replace(ANSI_RE, '') }

function extractLogLines(ev: WorkflowLogEvent): LogLine[] {
  const time = ev.timestamp ? new Date(ev.timestamp).toLocaleTimeString('en-US', { hour12: false }) : ''
  const p = ev.payload as Record<string, unknown> | undefined
  if (!p) {return []}

  // Live log.appended events (real-time streaming)
  if (ev.type === 'log.appended') {
    const msg = typeof p.message === 'string' ? stripAnsi(p.message) : ''
    if (!msg) {return []}
    const stream = (p.stream as 'stdout' | 'stderr') ?? 'stdout'
    return [{ time, text: msg, stream }]
  }

  const stdout = (p.outputs as Record<string, unknown> | undefined)?.stdout ?? p.stdout
  if (typeof stdout === 'string' && stdout.trim()) {
    return stripAnsi(stdout).trim().split('\n').map(text => ({ time, text, stream: 'stdout' as const }))
  }
  const stderr = (p.outputs as Record<string, unknown> | undefined)?.stderr ?? p.stderr
  if (typeof stderr === 'string' && stderr.trim()) {
    return stripAnsi(stderr).trim().split('\n').map(text => ({ time, text, stream: 'stderr' as const }))
  }
  if (typeof p.error === 'string') {return [{ time, text: p.error, stream: 'stderr' }]}
  if (typeof p.message === 'string') {return [{ time, text: p.message }]}
  if (typeof p.line === 'string') {return [{ time, text: p.line }]}
  if (typeof p.text === 'string') {return [{ time, text: p.text }]}
  return []
}

const LOG_SKIP_KEYS = new Set(['stdout', 'stderr', 'exitCode', 'ok'])

interface StepDetailDrawerProps {
  step: StepRun | null
  events: WorkflowLogEvent[]
  open: boolean
  onClose: () => void
  onApprove?: () => void
}

export function StepDetailDrawer({ step, events, open, onClose, onApprove }: StepDetailDrawerProps) {
  const sseLines = useMemo(() => events.flatMap(extractLogLines), [events])
  const logRef = useRef<HTMLPreElement>(null)

  // Auto-scroll to bottom when new lines arrive
  useEffect(() => {
    const el = logRef.current
    if (!el) {return}
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (isNearBottom) {
      el.scrollTop = el.scrollHeight
    }
  }, [sseLines.length])

  const pollingLines = useMemo<LogLine[]>(() => {
    if (!step?.outputs || sseLines.length > 0) {return []}
    const lines: LogLine[] = []
    const { stdout, stderr } = step.outputs as { stdout?: unknown; stderr?: unknown }
    if (typeof stdout === 'string' && stdout.trim()) {
      stdout.trim().split('\n').forEach(text => lines.push({ time: '', text }))
    }
    if (typeof stderr === 'string' && stderr.trim()) {
      stderr.trim().split('\n').forEach(text => lines.push({ time: '', text }))
    }
    if (lines.length === 0) {
      const keys = Object.keys(step.outputs).filter(k => !LOG_SKIP_KEYS.has(k))
      if (keys.length > 0) {lines.push({ time: '', text: `Output: { ${keys.join(', ')} }` })}
    }
    return lines
  }, [step?.outputs, sseLines.length])

  const lines = sseLines.length > 0 ? sseLines : pollingLines

  const dataOutputs = useMemo(() => {
    if (!step?.outputs) {return null}
    const filtered: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(step.outputs)) {
      if (!LOG_SKIP_KEYS.has(k)) {filtered[k] = v}
    }
    return Object.keys(filtered).length > 0 ? filtered : null
  }, [step?.outputs])

  const hasInputs = step?.spec?.with != null && Object.keys(step.spec.with).length > 0
  const hasError = step?.error != null
  const hasData = dataOutputs !== null

  const logContent = (
    <div style={{ fontFamily: 'monospace', fontSize: 12 }}>
      {lines.length > 0 ? (
        <pre ref={logRef} style={{
          margin: 0,
          padding: '8px 12px',
          background: '#0d1117',
          color: '#c9d1d9',
          borderRadius: 4,
          overflow: 'auto',
          maxHeight: 500,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          lineHeight: 1.6,
        }}>
          {lines.map((l, i) => (
            <span key={i}>
              {l.time && <span style={{ color: 'var(--text-tertiary)', userSelect: 'none', marginRight: 12 }}>{l.time}</span>}
              <span style={l.stream === 'stderr' ? { color: '#f85149' } : undefined}>{l.text}</span>{'\n'}
            </span>
          ))}
        </pre>
      ) : (
        <Text type="secondary" style={{ fontSize: 12 }}>
          {step?.status === 'running' ? 'Waiting for output...' :
           step?.status === 'queued' ? 'Not started yet' :
           step?.status === 'waiting_approval' ? 'Waiting for approval' :
           'No output'}
        </Text>
      )}
    </div>
  )

  const tabItems: UITabItem[] = [
    { key: 'log', label: 'Log', children: logContent },
  ]
  if (hasData) {tabItems.push({ key: 'data', label: 'Data', children: <UIJsonViewer data={dataOutputs} /> })}
  if (hasInputs) {tabItems.push({ key: 'inputs', label: 'Inputs', children: <UIJsonViewer data={step!.spec!.with} /> })}
  if (hasError) {tabItems.push({ key: 'error', label: 'Error', children: <UIJsonViewer data={step!.error} /> })}

  const statusColor = STATUS_COLOR[step?.status ?? 'queued']
  const duration = formatDuration(step?.durationMs)

  return (
    <UIDrawer
      open={open}
      onClose={onClose}
      title={
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>{step?.name ?? ''}</span>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: statusColor, fontWeight: 600 }}>
              {STATUS_LABEL[step?.status ?? 'queued']}
            </span>
            {duration && (
              <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                {duration}
              </span>
            )}
          </div>
        </div>
      }
      placement="right"
      width={520}
      footer={
        step?.status === 'waiting_approval' && onApprove ? (
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <UIButton variant="primary" onClick={onApprove}>
              Review &amp; Decide
            </UIButton>
          </div>
        ) : null
      }
    >
      {step && (
        tabItems.length > 1
          ? <UITabs items={tabItems} size="small" defaultActiveKey="log" />
          : logContent
      )}
    </UIDrawer>
  )
}
