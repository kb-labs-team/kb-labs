import type { JobState, RunState, StepState } from './index'

/**
 * Single source of truth for legal status transitions across the workflow
 * engine. Every status-write call site (engine.ts, worker.ts) must route
 * through `assertTransition` (via StateStore.transitionRun/Job/Step) instead
 * of mutating `.status` directly — this is what turns "any status can go to
 * any status" into a checked invariant.
 *
 * See docs/adr and the workflow status audit for the incident this closes:
 * a job could be marked `failed` while its step still sat in
 * `waiting_approval`, because nothing validated that transition was legal.
 */

export type EntityKind = 'run' | 'job' | 'step'

// ═══════════════════════════════════════════════════════════════════════
// Transition tables
// ═══════════════════════════════════════════════════════════════════════

export const RUN_TRANSITIONS = {
  // 'success'/'failed': a run can finish without ever visiting 'running' —
  // e.g. a run whose only job is skipped via `if:` (`skipJob` marks the job
  // success directly and never calls `markJobStarted`, so `run.status` can
  // still be 'queued' by the time `checkRunCompletion` finalizes the run).
  queued: ['running', 'cancelled', 'success', 'failed'],
  running: ['success', 'failed', 'cancelled', 'dlq'],
  success: [],
  failed: [],
  cancelled: [],
  skipped: [],
  dlq: [],
} as const satisfies Record<RunState, readonly RunState[]>

type RunSourcesFor<Target extends RunState> = {
  [Source in RunState]: Target extends (typeof RUN_TRANSITIONS)[Source][number] ? Source : never
}[RunState]

export type TerminalRunState = {
  [Status in RunState]: typeof RUN_TRANSITIONS[Status] extends readonly []
    ? [RunSourcesFor<Status>] extends [never] ? never : Status
    : never
}[RunState]

export const JOB_TRANSITIONS: Record<JobState, readonly JobState[]> = {
  // 'success': `skipJob` treats an `if:`-skipped job as success directly,
  // without ever passing through 'running' (see engine.ts `skipJob`).
  // 'failed': `cleanupStaleRuns` force-fails abandoned jobs that never even
  // started (daemon restarted before they were dequeued).
  queued: ['running', 'cancelled', 'skipped', 'success', 'failed'],
  // 'queued': a running job can be re-parked back to queued mid-execution
  // when its current step legitimately pauses (waiting_child reconciliation
  // resume, gate restart) — not a hard requirement that 'running' only ever
  // moves forward.
  running: ['success', 'failed', 'cancelled', 'interrupted', 'waiting_approval', 'waiting_child', 'queued'],
  // 'failed': a parked job can be force-failed directly, without ever
  // passing through 'running' again — e.g. `failChildInvocation` fails the
  // parent job when its child run was cancelled/not found/itself failed,
  // while the parent job is still sitting in 'waiting_child'.
  waiting_approval: ['queued', 'cancelled', 'failed'],
  waiting_child: ['queued', 'cancelled', 'failed'],
  interrupted: ['queued', 'cancelled'],
  success: [],
  // 'queued': `markJobFailed` schedules a retry after a transient failure —
  // the job comes back as 'queued' for its next attempt. 'failed' here means
  // "this attempt failed", not always "this job is permanently done"; the
  // caller decides whether to retry before ever reaching a real terminal
  // outcome for the job.
  failed: ['queued'],
  cancelled: [],
  skipped: [],
}

export const STEP_TRANSITIONS: Record<StepState, readonly StepState[]> = {
  // 'success': a gate's skip-forward decision marks intervening steps
  // success directly (skipped: true in outputs), without ever running them —
  // mirrors JOB_TRANSITIONS.queued's 'success' for the same reason.
  // 'waiting_approval'/'waiting_child': `builtin:approval` and nested
  // `workflow:` invocation steps never call `markStepStarted` at all (see
  // worker.ts's step loop) — they park straight from 'queued', there's no
  // "running" phase to observe for these step kinds.
  queued: ['running', 'skipped', 'cancelled', 'success', 'waiting_approval', 'waiting_child'],
  running: ['success', 'failed', 'waiting_approval', 'waiting_child'],
  waiting_approval: ['success', 'failed'],
  // Reconciliation may restart a parked child-invocation step back to `running`.
  waiting_child: ['success', 'failed', 'running'],
  success: [],
  failed: [],
  cancelled: [],
  skipped: [],
  dlq: [],
}

const TRANSITIONS: Record<EntityKind, Record<string, readonly string[]>> = {
  run: RUN_TRANSITIONS,
  job: JOB_TRANSITIONS,
  step: STEP_TRANSITIONS,
}

// ═══════════════════════════════════════════════════════════════════════
// Predicates
// ═══════════════════════════════════════════════════════════════════════

/**
 * Terminal: no legal outgoing transition. The entity is done, one way or
 * another, and nothing should ever flip it again.
 */
function terminalStates(transitions: Record<string, readonly string[]>): ReadonlySet<string> {
  return new Set(Object.entries(transitions).flatMap(([state, next]) => next.length === 0 ? [state] : []))
}

const TERMINAL_STATES: Record<EntityKind, ReadonlySet<string>> = {
  run: terminalStates(RUN_TRANSITIONS),
  job: new Set(['success', 'failed', 'cancelled', 'skipped']),
  step: new Set(['success', 'failed', 'cancelled', 'skipped', 'dlq']),
}

/**
 * Parked: not terminal, but also not actively holding an executor slot.
 * Something external (a human approval, a child run finishing, a daemon
 * restart recovery pass) is expected to move it back to `queued`/`running`.
 *
 * This is the status class `cleanupStaleRuns` must never force-fail — that
 * was the root cause of the reported bug (job.status=failed while
 * step.status=waiting_approval).
 */
const PARKED_STATES: Record<EntityKind, ReadonlySet<string>> = {
  run: new Set([]),
  job: new Set(['waiting_approval', 'waiting_child', 'interrupted']),
  step: new Set(['waiting_approval', 'waiting_child']),
}

/**
 * Active: currently executing or eligible to be picked up by the next
 * scheduler tick, i.e. genuinely needs a live executor.
 */
const ACTIVE_STATES: Record<EntityKind, ReadonlySet<string>> = {
  run: new Set(['queued', 'running']),
  job: new Set(['queued', 'running']),
  step: new Set(['queued', 'running']),
}

export function isTerminal(state: string, kind: EntityKind): boolean {
  return TERMINAL_STATES[kind].has(state)
}

export function isParked(state: string, kind: EntityKind): boolean {
  return PARKED_STATES[kind].has(state)
}

export function isActive(state: string, kind: EntityKind): boolean {
  return ACTIVE_STATES[kind].has(state)
}

// ═══════════════════════════════════════════════════════════════════════
// Transition validation
// ═══════════════════════════════════════════════════════════════════════

export class IllegalStateTransitionError extends Error {
  constructor(
    public readonly kind: EntityKind,
    public readonly from: string,
    public readonly to: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(`Illegal ${kind} status transition: ${from} → ${to}`)
    this.name = 'IllegalStateTransitionError'
  }
}

export interface AssertTransitionOptions {
  /**
   * Bulk-reset escape hatch for replayRun/cleanupStaleRuns-style resets that
   * deliberately move a terminal entity back to `queued` (or similar) outside
   * the normal transition table. Must be passed explicitly and is grep-able
   * by design — never add a silent bypass inside the table itself.
   */
  allowReset?: boolean
}

/**
 * Throws IllegalStateTransitionError if `to` is not reachable from `from`
 * per the transition table for `kind`. No-ops (does not throw) when
 * `from === to` — idempotent re-writes of the same status are always legal.
 */
export function assertTransition(
  kind: EntityKind,
  from: string,
  to: string,
  options: AssertTransitionOptions = {},
): void {
  if (from === to) {
    return
  }
  if (options.allowReset) {
    return
  }
  const legal = TRANSITIONS[kind][from]
  if (!legal || !legal.includes(to)) {
    throw new IllegalStateTransitionError(kind, from, to)
  }
}
