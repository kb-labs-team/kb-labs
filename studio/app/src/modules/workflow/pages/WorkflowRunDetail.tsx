/**
 * @module @kb-labs/studio-app/modules/workflows/pages/workflow-run-page
 * Workflow run detail page with live SSE logs, jobs/steps accordion, and approval modal
 */

import React from 'react'
import { useMutateData } from '@kb-labs/studio-hooks';
import { useSSE } from '@kb-labs/studio-hooks';
import { UIPage, UIPageHeader, UIPageSection } from '@kb-labs/studio-ui-kit';
import { useMemo, useState, useEffect, useRef, useCallback } from 'react'
import { useParams, Link } from 'react-router-dom'
import {
  UIButton, UITypographyText, UISkeletonText, UITitle, UIAlert, UIList, UIListItem, UIAccordion, UITabs, UIJsonViewer } from '@kb-labs/studio-ui-kit';
import type { UIAccordionItem, UITabItem } from '@kb-labs/studio-ui-kit';
import { useData } from '@kb-labs/studio-hooks';
import type { WorkflowRun, JobRun, StepRun } from '@kb-labs/workflow-contracts'
import type { WorkflowLogEvent } from '@kb-labs/workflow-contracts/rest-api'
import { projectWorkflowEndpoint } from '@kb-labs/workflow-contracts/routes'
import { useWorkflowProject } from '../components/shared/WorkflowProjectPicker'
import { WorkflowStatusBadge } from '../components/shared/WorkflowStatusBadge'
import { ConnectionBadge } from '../components/shared/ConnectionBadge'
import { ApprovalModal } from '../components/ApprovalModal'
import { PipelineView } from '../components/pipeline/PipelineView'
import { DashboardView } from '../components/dashboard/DashboardView'
import { GraphView } from '../components/graph/GraphView'
import { ViewModeSelector } from '../components/shared/ViewModeSelector'

const Text = UITypographyText
const Title = UITitle

export function RunInputs({ inputs }: { inputs?: Record<string, unknown> }) {
  if (!inputs || Object.keys(inputs).length === 0) {return null}
  return (
    <section aria-label="Submitted inputs" style={{ margin: '12px 0 20px' }}>
      <Title level={4}>Submitted Inputs</Title>
      <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 12px', margin: 0 }}>
        {Object.entries(inputs).map(([name, value]) => (
          <React.Fragment key={name}>
            <dt style={{ fontWeight: 600 }}>{`${name}:`}</dt>
            <dd style={{ margin: 0 }}>{typeof value === 'string' ? value : JSON.stringify(value)}</dd>
          </React.Fragment>
        ))}
      </dl>
    </section>
  )
}

// --- GitHub Actions style execution log ---

const STATUS_ICON: Record<string, string> = {
  'queued': '\u25CB',
  'running': '\u25C9',
  'success': '\u2713',
  'failed': '\u2717',
  'cancelled': '\u2298',
  'skipped': '\u2014',
  'waiting_approval': '\u23F8',
  // Jobs (not just steps) can now carry these too \u2014 parked while a step
  // waits on a human decision or a nested workflow.
  'waiting_child': '\u23F8',
  'interrupted': '\u2016',
}

const STATUS_COLOR: Record<string, string> = {
  'queued': '#8b949e',
  'running': '#d29922',
  'success': '#3fb950',
  'failed': '#f85149',
  'cancelled': '#8b949e',
  'skipped': '#8b949e',
  'waiting_approval': '#d29922',
  'waiting_child': '#d29922',
  'interrupted': '#d29922',
}

function eventTypeToStatus(type: string): string {
  if (type.endsWith('.started')) {return 'running'}
  if (type.endsWith('.succeeded') || type.endsWith('.finished')) {return 'success'}
  if (type.endsWith('.failed')) {return 'failed'}
  if (type.endsWith('.cancelled')) {return 'cancelled'}
  if (type.endsWith('.skipped')) {return 'skipped'}
  if (type.endsWith('.waitingApproval')) {return 'waiting_approval'}
  if (type.endsWith('.queued')) {return 'queued'}
  return 'running'
}

function formatDurationMs(ms: number): string {
  if (ms < 1000) {return `${ms}ms`}
  const s = ms / 1000
  if (s < 60) {return `${s.toFixed(1)}s`}
  const m = Math.floor(s / 60)
  const rem = Math.floor(s % 60)
  return `${m}m ${rem}s`
}

function formatTime(ts?: string): string {
  if (!ts) {return ''}
  try {
    return new Date(ts).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch { return '' }
}

interface LogLine {
  time: string
  text: string
  stream?: 'stdout' | 'stderr'
}

// Strip ANSI escape codes from text
 
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]|\x1b\].*?\x07/g
function stripAnsi(s: string): string { return s.replace(ANSI_RE, '') }

function extractLogLines(ev: WorkflowLogEvent): LogLine[] {
  const time = formatTime(ev.timestamp)
  const payload = ev.payload as Record<string, unknown> | undefined
  if (!payload) {return []}

  // Live log.appended events (real-time streaming)
  if (ev.type === 'log.appended') {
    const msg = typeof payload.message === 'string' ? stripAnsi(payload.message) : ''
    if (!msg) {return []}
    const stream = (payload.stream as 'stdout' | 'stderr') ?? 'stdout'
    return [{ time, text: msg, stream }]
  }

  if (payload.outputs && typeof payload.outputs === 'object') {
    const outputs = payload.outputs as Record<string, unknown>
    if (typeof outputs.stdout === 'string' && outputs.stdout.trim()) {
      return stripAnsi(outputs.stdout).trim().split('\n').map(line => ({ time, text: line, stream: 'stdout' as const }))
    }
  }
  if (typeof payload.stdout === 'string' && payload.stdout.trim()) {
    return stripAnsi(payload.stdout).trim().split('\n').map(line => ({ time, text: line, stream: 'stdout' as const }))
  }
  if (typeof payload.error === 'string') {
    return [{ time, text: payload.error, stream: 'stderr' }]
  }
  if (typeof payload.message === 'string') {
    return [{ time, text: payload.message }]
  }
  if (typeof payload.line === 'string') {
    return [{ time, text: payload.line }]
  }
  if (typeof payload.text === 'string') {
    return [{ time, text: payload.text }]
  }
  const keys = Object.keys(payload).filter(k => !['status', 'jobName', 'durationMs', 'attempt'].includes(k))
  if (keys.length === 0) {return []}
  return [{ time, text: JSON.stringify(payload, null, 2) }]
}

interface StepLogGroup {
  stepId: string
  stepName: string
  status: string
  command?: string
  events: WorkflowLogEvent[]
  outputs?: Record<string, unknown>
  error?: Record<string, unknown> | null
  spec?: { name: string; uses?: string; with?: Record<string, unknown> }
  startedAt?: string
  finishedAt?: string
  durationMs?: number
}

interface JobLogGroup {
  jobId: string
  jobName: string
  status: string
  steps: StepLogGroup[]
  events: WorkflowLogEvent[]
  startedAt?: string
  finishedAt?: string
  durationMs?: number
  error?: Record<string, unknown> | null
}

function buildLogGroups(events: WorkflowLogEvent[], run: WorkflowRun): JobLogGroup[] {
  const jobMap = new Map<string, JobLogGroup>()

  for (const job of run.jobs) {
    const stepGroups: StepLogGroup[] = job.steps.map(s => ({
      stepId: s.id,
      stepName: s.name,
      status: s.status,
      command: (s as StepRun & { command?: string }).command,
      events: [],
      outputs: s.outputs ?? undefined,
      error: s.error,
      spec: s.spec,
      startedAt: s.startedAt,
      finishedAt: s.finishedAt,
      durationMs: s.durationMs,
    }))
    jobMap.set(job.id, {
      jobId: job.id,
      jobName: job.jobName,
      status: job.status,
      steps: stepGroups,
      events: [],
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      durationMs: job.durationMs,
      error: job.error,
    })
  }

  for (const ev of events) {
    if (!ev.jobId) {continue}
    let group = jobMap.get(ev.jobId)
    if (!group) {
      group = {
        jobId: ev.jobId,
        jobName: ev.jobId,
        status: eventTypeToStatus(ev.type),
        steps: [],
        events: [],
      }
      jobMap.set(ev.jobId, group)
    }

    if (ev.type.startsWith('job.')) {
      group.status = eventTypeToStatus(ev.type)
      if (ev.payload?.jobName) {group.jobName = String(ev.payload.jobName)}
      if (ev.payload?.durationMs) {group.durationMs = Number(ev.payload.durationMs)}
    }

    if (ev.stepId) {
      let step = group.steps.find(s => s.stepId === ev.stepId)
      if (!step) {
        step = { stepId: ev.stepId, stepName: ev.stepId, status: 'queued', events: [] }
        group.steps.push(step)
      }
      step.events.push(ev)
      if (ev.type.startsWith('step.')) {
        step.status = eventTypeToStatus(ev.type)
      }
    } else {
      group.events.push(ev)
    }
  }

  return Array.from(jobMap.values())
}

const LOG_OUTPUT_KEYS = new Set(['stdout', 'stderr', 'exitCode', 'ok'])

function StepPanel({ step, onApprove }: { step: StepLogGroup; onApprove?: () => void }) {
  const sseLines: LogLine[] = step.events.flatMap(extractLogLines)
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

  const pollingLines: LogLine[] = useMemo(() => {
    if (sseLines.length > 0) {return []}
    const lines: LogLine[] = []
    if (step.outputs) {
      const stdout = step.outputs.stdout
      const stderr = step.outputs.stderr
      if (typeof stdout === 'string' && stdout.trim()) {
        for (const line of stdout.trim().split('\n')) {
          lines.push({ time: '', text: line })
        }
      }
      if (typeof stderr === 'string' && stderr.trim()) {
        for (const line of stderr.trim().split('\n')) {
          lines.push({ time: '', text: line })
        }
      }
      // If no stdout/stderr but has structured data — show compact summary
      if (lines.length === 0) {
        const dataKeys = Object.keys(step.outputs).filter(k => !LOG_OUTPUT_KEYS.has(k))
        if (dataKeys.length > 0) {
          lines.push({ time: '', text: `Completed with output: { ${dataKeys.join(', ')} }` })
        }
      }
    }
    if (step.error) {
      const msg = (step.error as Record<string, unknown>).message
      if (typeof msg === 'string') {
        lines.push({ time: '', text: msg })
      }
    }
    return lines
  }, [step.outputs, step.error, sseLines.length])

  const lines = sseLines.length > 0 ? sseLines : pollingLines
  const isWaiting = step.status === 'waiting_approval'

  const dataOutputs = useMemo(() => {
    if (!step.outputs) {return null}
    const filtered: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(step.outputs)) {
      if (!LOG_OUTPUT_KEYS.has(k)) {filtered[k] = v}
    }
    return Object.keys(filtered).length > 0 ? filtered : null
  }, [step.outputs])

  const hasData = dataOutputs !== null
  const hasInputs = step.spec?.with != null && Object.keys(step.spec.with).length > 0
  const hasError = step.error != null
  const hasTabs = hasData || hasInputs || hasError

  const logContent = (
    <div style={{ fontFamily: 'monospace', fontSize: 13 }}>
      {step.command && (
        <div style={{ padding: '4px 12px', color: '#8b949e', fontSize: 12 }}>
          $ {step.command}
        </div>
      )}
      {lines.length > 0 ? (
        <pre ref={logRef} style={{
          margin: 0,
          padding: '8px 12px',
          background: '#0d1117',
          color: '#c9d1d9',
          borderRadius: 4,
          overflow: 'auto',
          maxHeight: 400,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          lineHeight: 1.6,
        }}>
          {lines.map((l, i) => (
            <span key={i}>
              {l.time && <span style={{ color: '#484f58', userSelect: 'none', marginRight: 12 }}>{l.time}</span>}
              <span style={l.stream === 'stderr' ? { color: '#f85149' } : undefined}>{l.text}</span>
              {'\n'}
            </span>
          ))}
        </pre>
      ) : (
        <Text type="secondary" style={{ fontSize: 12, padding: '4px 12px', display: 'block' }}>
          {step.status === 'running' ? 'Waiting for output...' :
           step.status === 'queued' ? 'Queued' :
           isWaiting ? 'Waiting for approval' :
           'No output'}
        </Text>
      )}
      {isWaiting && onApprove && (
        <div style={{ padding: '8px 12px' }}>
          <UIButton size="small" variant="primary" onClick={onApprove}>
            Review &amp; Decide
          </UIButton>
        </div>
      )}
    </div>
  )

  if (!hasTabs) {return logContent}

  const tabItems: UITabItem[] = [
    { key: 'log', label: 'Log', children: logContent },
  ]
  if (hasData) {
    tabItems.push({ key: 'data', label: 'Data', children: <UIJsonViewer data={dataOutputs} /> })
  }
  if (hasInputs) {
    tabItems.push({ key: 'inputs', label: 'Inputs', children: <UIJsonViewer data={step.spec!.with} /> })
  }
  if (hasError) {
    tabItems.push({ key: 'error', label: 'Error', children: <UIJsonViewer data={step.error} /> })
  }

  return <UITabs items={tabItems} size="small" defaultActiveKey="log" />
}

interface JobStepLogProps {
  events: WorkflowLogEvent[]
  run: WorkflowRun
  onApprove?: (step: StepRun) => void
}

function JobStepLog({ events, run, onApprove }: JobStepLogProps) {
  const groups = useMemo(() => buildLogGroups(events, run), [events, run])

  const stepRunMap = useMemo(() => {
    const map = new Map<string, StepRun>()
    for (const job of run.jobs) {
      for (const step of job.steps) {
        map.set(step.id, step)
      }
    }
    return map
  }, [run])

  if (groups.length === 0) {
    return <Text type="secondary">No execution data yet.</Text>
  }

  const activeJobKeys = groups
    .filter(g => g.status === 'running' || g.status === 'failed' || g.status === 'waiting_approval' || g.status === 'waiting_child')
    .map(g => g.jobId)
  const defaultJobKeys = activeJobKeys.length > 0 ? activeJobKeys : groups.map(g => g.jobId)

  const jobItems: UIAccordionItem[] = groups.map(group => {
    const icon = STATUS_ICON[group.status] ?? '?'
    const color = STATUS_COLOR[group.status] ?? '#8b949e'
    const duration = group.durationMs ? formatDurationMs(group.durationMs) : null

    const activeStepKeys = group.steps
      .filter(s => s.status === 'running' || s.status === 'failed' || s.status === 'waiting_approval' || s.status === 'waiting_child')
      .map(s => s.stepId)
    const defaultStepKeys = activeStepKeys.length > 0
      ? activeStepKeys
      : group.steps.filter(s => s.status !== 'queued').map(s => s.stepId)

    const stepItems: UIAccordionItem[] = group.steps.map(step => {
      const sIcon = STATUS_ICON[step.status] ?? '?'
      const sColor = STATUS_COLOR[step.status] ?? '#8b949e'
      const sDuration = step.durationMs ? formatDurationMs(step.durationMs) : null
      return {
        key: step.stepId,
        label: step.stepName,
        extra: (
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            {sDuration && <span style={{ color: '#8b949e' }}>{sDuration}</span>}
            <span style={{ color: sColor, fontWeight: 600, fontSize: 14 }}>{sIcon}</span>
          </span>
        ),
        children: (
          <StepPanel
            step={step}
            onApprove={
              step.status === 'waiting_approval' && onApprove
                ? () => {
                    const sr = stepRunMap.get(step.stepId)
                    if (sr) {onApprove(sr)}
                  }
                : undefined
            }
          />
        ),
      }
    })

    return {
      key: group.jobId,
      label: group.jobName,
      extra: (
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
          {duration && <span style={{ color: '#8b949e' }}>{duration}</span>}
          <span style={{ color, fontWeight: 600, fontSize: 14 }}>{icon}</span>
        </span>
      ),
      children: (
        <>
          {group.error && group.status === 'failed' && (
            <UIAlert
              variant="error"
              message="Job failed"
              description={
                typeof group.error.message === 'string'
                  ? group.error.message
                  : JSON.stringify(group.error, null, 2)
              }
              showIcon
              style={{ marginBottom: 8 }}
            />
          )}
          {stepItems.length > 0 ? (
            <UIAccordion
              items={stepItems}
              defaultActiveKey={defaultStepKeys}
              size="small"
              ghost
              style={{ background: 'transparent' }}
            />
          ) : (
            <Text type="secondary" style={{ fontSize: 12 }}>No steps.</Text>
          )}
        </>
      ),
    }
  })

  return (
    <UIAccordion
      items={jobItems}
      defaultActiveKey={defaultJobKeys}
      size="small"
      style={{ background: 'var(--bg-secondary, #f6f8fa)' }}
    />
  )
}

// ─── Skeleton ──────────────────────────────────────────────────────

function SkeletonBlock({ width, height, style }: { width: number | string; height: number; style?: React.CSSProperties }) {
  return <UISkeletonText width={width} height={height} style={style} />
}
function RunDetailSkeleton() {
  return (
    <>
      <div style={{ display: 'flex', gap: 12, padding: '12px 16px', background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)', borderRadius: 8, marginBottom: 24 }}>
        <SkeletonBlock width={60} height={20} /><SkeletonBlock width={120} height={20} /><SkeletonBlock width={80} height={20} /><SkeletonBlock width={140} height={20} style={{ marginLeft: 'auto' }} />
      </div>
      <SkeletonBlock width="100%" height={32} style={{ marginBottom: 16, borderRadius: 8 }} />
      <div style={{ padding: '20px 24px', background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)', borderRadius: 10, marginBottom: 16 }}>
        <SkeletonBlock width={200} height={16} style={{ marginBottom: 12 }} /><SkeletonBlock width="60%" height={12} />
      </div>
      {[1, 2, 3].map(i => (
        <div key={i} style={{ display: 'flex', gap: 8, padding: '8px 12px', border: '1px solid var(--border-primary)', borderRadius: 6, marginBottom: 6 }}>
          <SkeletonBlock width={14} height={14} style={{ borderRadius: '50%', flexShrink: 0 }} /><SkeletonBlock width={`${50 + i * 15}%`} height={14} />
        </div>
      ))}
    </>
  )
}

// ─── SSE state patching ────────────────────────────────────────────

function applyStateEvent(run: WorkflowRun, ev: WorkflowLogEvent): WorkflowRun {
  const { type, jobId, stepId, payload } = ev
  if (type === 'run.started') {return { ...run, status: 'running', startedAt: (payload?.startedAt as string) ?? run.startedAt }}
  if (type === 'run.finished') {return { ...run, status: 'success' }}
  if (type === 'run.failed') {return { ...run, status: 'failed' }}
  if (type === 'run.cancelled') {return { ...run, status: 'cancelled' }}
  if (!jobId) {return run}
  const jobs = run.jobs.map(j => {
    if (j.id !== jobId) {return j}
    if (type.startsWith('job.')) {return { ...j, status: eventTypeToStatus(type) as JobRun['status'], durationMs: (payload?.durationMs as number) ?? j.durationMs }}
    if (!stepId) {return j}
    const steps = j.steps.map(s => s.id !== stepId || !type.startsWith('step.') ? s : {
      ...s,
      status: eventTypeToStatus(type) as StepRun['status'],
      startedAt: type === 'step.started' ? ((payload?.startedAt as string) ?? s.startedAt) : s.startedAt,
      durationMs: (payload?.durationMs as number) ?? s.durationMs,
      error: (payload?.error as StepRun['error'] | undefined) ?? s.error,
    })
    return { ...j, steps }
  })
  return { ...run, jobs }
}

const TERMINAL_STATUSES = new Set(['success', 'failed', 'cancelled', 'skipped', 'dlq'])
const STATE_EVENT_PREFIXES = ['run.', 'job.', 'step.']

export default function WorkflowRunDetail() {
  const params = useParams<{ runId: string }>()
  const runId = params.runId ?? null
  const { projectId, picker, hasProjects } = useWorkflowProject()
  const { data: runData, isLoading, error, refetch } = useData<{ run: WorkflowRun }>(
    projectWorkflowEndpoint(projectId, runId ? `runs/${encodeURIComponent(runId)}` : 'runs/__none__'),
    { enabled: !!runId && hasProjects, pollingMs: 10_000 },
  )

  const [localRun, setLocalRun] = useState<WorkflowRun | null>(null)
  useEffect(() => {
    const fetched = runData?.run ?? (runData as unknown as WorkflowRun | undefined) ?? null
    if (fetched) {setLocalRun(fetched)}
  }, [runData])

  const run = localRun
  const cancelMutation = useMutateData<void, void>(projectWorkflowEndpoint(projectId, `runs/${encodeURIComponent(runId ?? '__none__')}/cancel`))
  const resolveApproval = useMutateData<
    { runId: string; jobId: string; stepId: string; action: string; comment?: string },
    unknown
  >(projectWorkflowEndpoint(projectId, `runs/${encodeURIComponent(runId ?? '__none__')}/approvals/resolve`))
  const isRunActive = run != null && !TERMINAL_STATUSES.has(run.status)

  const [lastEventAt, setLastEventAt] = useState<Date | undefined>(undefined)
  const handleSseEvent = useCallback((ev: WorkflowLogEvent) => {
    const isStateEvent = STATE_EVENT_PREFIXES.some(p => ev.type.startsWith(p)) && ev.type !== 'log.appended'
    if (isStateEvent) {setLocalRun(prev => prev ? applyStateEvent(prev, ev) : prev)}
    setLastEventAt(new Date())
  }, [])

  const { events, error: logError, connectionStatus } = useSSE<WorkflowLogEvent>(
    isRunActive && runId && !isLoading ? projectWorkflowEndpoint(projectId, `runs/${encodeURIComponent(runId)}/events`) : null,
    { events: 'workflow.event', terminalEvents: ['workflow.done'], params: { follow: 1 }, reconnect: true, onEvent: handleSseEvent },
  )

  const [approvalStep, setApprovalStep] = useState<StepRun | null>(null)
  const [viewMode, setViewMode] = useState<'dashboard' | 'pipeline' | 'graph' | 'engineering'>('dashboard')

  const VIEW_MODES = {
    dashboard:   { label: 'Dashboard' },
    pipeline:    { label: 'Pipeline' },
    graph:       { label: 'Graph' },
    engineering: { label: 'Engineering' },
  } as const

  useEffect(() => {
    if (logError && isRunActive) {void refetch()}
  }, [logError, isRunActive, refetch])

  const isTerminal = run != null && !isRunActive

  const hasPendingApprovals = run?.jobs.some(j =>
    j.steps.some(s => (s.status as string) === 'waiting_approval')
  )

  const handleApprovalResolve = async (action: 'approve' | 'reject', comment?: string) => {
    if (!approvalStep || !runId) {return}
    const job = run?.jobs.find(j => j.steps.some(s => s.id === approvalStep.id))
    if (!job) {return}
    await resolveApproval.mutateAsync({
      runId,
      jobId: job.id,
      stepId: approvalStep.id,
      action,
      comment,
    })
    setApprovalStep(null)
    void refetch()
  }

  const shortRunId = runId ? `${runId.slice(0, 12)}...` : ''

  return (
    <UIPage>
      <UIPageHeader
        title={run?.name ?? `Workflow Run ${shortRunId}`}
        description={run ? `Run ${shortRunId}` : 'Detailed status of the workflow execution'}
        breadcrumbs={[
          { title: 'Home', href: '/' },
          { title: 'Workflows', href: '/workflows' },
          { title: 'Runs', href: '/p/workflows/runs' },
          { title: shortRunId },
        ]}
        actions={
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {picker}
            <ConnectionBadge status={connectionStatus} lastEventAt={lastEventAt} />
            <UIButton onClick={() => refetch()} disabled={isLoading}>
              Refresh
            </UIButton>
            {run && !isTerminal && (
              <UIButton
                danger
                loading={cancelMutation.isLoading}
                onClick={() => runId && cancelMutation.mutate()}
              >
                Cancel Run
              </UIButton>
            )}
          </div>
        }
      />

      {error && <UIAlert variant="error" message="Failed to load workflow run" description={String(error)} showIcon closable />}

      {hasPendingApprovals && (
        <UIAlert
          variant="warning"
          message="Waiting for your approval"
          description="One or more steps require your decision. Expand the step below to review."
          showIcon
          style={{ marginBottom: 16 }}
        />
      )}

      {isLoading && (
        <UIPageSection>
          <RunDetailSkeleton />
        </UIPageSection>
      )}
      {!isLoading && !run && !error && <UIPageSection><Text>Workflow run not found.</Text></UIPageSection>}
      {run && (
        <UIPageSection>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            padding: '8px 16px',
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border-primary)',
            borderRadius: 8,
            flexWrap: 'wrap',
            marginBottom: 8,
          }}>
            <WorkflowStatusBadge status={run.status} />
            <Link
              to={`/p/workflows/definitions/${encodeURIComponent(run.name)}`}
              style={{ color: 'var(--link)', fontWeight: 500, fontSize: 14 }}
            >
              {run.name}
            </Link>
            <span style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>
              v{run.version}
            </span>
            <span style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>
              by {run.trigger?.actor ?? 'unknown'}
            </span>
            {run.trigger?.parentRunId && (
              <Link
                to={`/p/workflows/runs/${encodeURIComponent(run.trigger.parentRunId)}`}
                style={{ color: 'var(--link)', fontSize: 13 }}
              >
                Parent run
              </Link>
            )}
            {run.metadata?.workflowAncestors && (
              <span style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>
                Lineage: {run.metadata.workflowAncestors.join(' → ')}
              </span>
            )}
            {run.startedAt && (
              <span style={{ color: 'var(--text-tertiary)', fontSize: 13, marginLeft: 'auto' }}>
                {new Date(run.startedAt).toLocaleString()}
              </span>
            )}
            <span style={{ width: 1, alignSelf: 'stretch', background: 'var(--border-primary)' }} />
            <ViewModeSelector views={VIEW_MODES} current={viewMode} onChange={setViewMode} />
            {runId && projectId && (
              <Link
                to={`/observability/logs?projectId=${encodeURIComponent(projectId)}&executionId=${encodeURIComponent(runId)}`}
                style={{ color: 'var(--link)', fontSize: 13 }}
              >
                Inspect run logs
              </Link>
            )}
          </div>

          {run.result?.summary && (
            <Text type="secondary" style={{ fontSize: 13, display: 'block', marginBottom: 12 }}>
              {run.result.summary}
            </Text>
          )}

          <RunInputs inputs={run.inputs} />

          {isRunActive && logError && connectionStatus !== 'reconnecting' && (
            <UIAlert variant="warning" message="Reconnecting to event stream…" description="Using polling as fallback" style={{ marginBottom: 12 }} />
          )}

          {viewMode === 'dashboard' && (
            <DashboardView
              run={run}
              onApprove={(step) => setApprovalStep(step)}
            />
          )}
          {viewMode === 'pipeline' && (
            <PipelineView
              run={run}
              events={events}
              onApprove={(step) => setApprovalStep(step)}
            />
          )}
          {viewMode === 'graph' && (
            <GraphView
              run={run}
              events={events}
              onApprove={(step) => setApprovalStep(step)}
            />
          )}
          {viewMode === 'engineering' && (
            <JobStepLog
              events={events}
              run={run}
              onApprove={(step) => setApprovalStep(step)}
            />
          )}
        </UIPageSection>
      )}

      {run?.result && (
        <UIPageSection>
          <Title level={4}>Result Metrics</Title>
          {run.result.metrics ? (
            <UIList
              bordered
              size="small"
              dataSource={Object.entries(run.result.metrics).map(([key, value]) => ({
                key,
                value,
              }))}
              renderItem={({ key, value }) => (
                <UIListItem>
                  <Text strong>{key}</Text>
                  <span style={{ marginLeft: 8 }}>{String(value ?? '-')}</span>
                </UIListItem>
              )}
            />
          ) : (
            <Text type="secondary">No metrics recorded.</Text>
          )}
          {run.result.error && (() => {
            const err = run.result.error
            const stack = typeof err.details?.['stack'] === 'string' ? err.details['stack'] as string : null
            const shortMsg = err.message.split('\n')[0]
            return (
              <UIAlert
                style={{ marginTop: 16 }}
                variant="error"
                message={shortMsg}
                description={stack ? (
                  <pre style={{
                    margin: '6px 0 0',
                    fontSize: 11,
                    lineHeight: 1.5,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                    maxHeight: 160,
                    overflowY: 'auto',
                    color: 'inherit',
                    opacity: 0.75,
                  }}>
                    {stack}
                  </pre>
                ) : undefined}
                showIcon
              />
            )
          })()}
        </UIPageSection>
      )}

      <ApprovalModal
        open={approvalStep !== null}
        step={approvalStep}
        onClose={() => setApprovalStep(null)}
        onResolve={handleApprovalResolve}
        isLoading={resolveApproval.isLoading}
        error={resolveApproval.error instanceof Error ? resolveApproval.error : null}
      />
    </UIPage>
  )
}
