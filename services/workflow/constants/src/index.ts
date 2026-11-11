const RUN_STATES = ['queued', 'running', 'success', 'failed', 'cancelled', 'skipped', 'dlq'] as const
const JOB_STATES = [
  'queued', 'running', 'success', 'failed', 'cancelled', 'skipped', 'interrupted',
  'waiting_approval', 'waiting_child',
] as const
const STEP_STATES = [...RUN_STATES, 'waiting_approval', 'waiting_child'] as const
const JOB_PRIORITIES = ['high', 'normal', 'low'] as const

export { RUN_STATES, JOB_STATES, STEP_STATES, JOB_PRIORITIES }

export type RunState = (typeof RUN_STATES)[number]
export type JobState = (typeof JOB_STATES)[number]
export type StepState = (typeof STEP_STATES)[number]
export type JobPriority = (typeof JOB_PRIORITIES)[number]

export {
  RUN_TRANSITIONS,
  JOB_TRANSITIONS,
  STEP_TRANSITIONS,
  isTerminal,
  isParked,
  isActive,
  assertTransition,
  IllegalStateTransitionError,
} from './state-machine'
export type { EntityKind, AssertTransitionOptions, TerminalRunState } from './state-machine'

export const EVENT_NAMES = {
  run: {
    created: 'run.created',
    started: 'run.started',
    updated: 'run.updated',
    finished: 'run.finished',
    cancelled: 'run.cancelled',
    failed: 'run.failed',
  },
  job: {
    queued: 'job.queued',
    started: 'job.started',
    updated: 'job.updated',
    succeeded: 'job.succeeded',
    failed: 'job.failed',
    cancelled: 'job.cancelled',
    skipped: 'job.skipped',
  },
  step: {
    queued: 'step.queued',
    started: 'step.started',
    updated: 'step.updated',
    succeeded: 'step.succeeded',
    failed: 'step.failed',
    cancelled: 'step.cancelled',
    skipped: 'step.skipped',
    waitingApproval: 'step.waitingApproval',
    waitingChild: 'step.waitingChild',
  },
  log: {
    appended: 'log.appended',
  },
} as const

export type WorkflowEventName =
  | (typeof EVENT_NAMES)['run'][keyof (typeof EVENT_NAMES)['run']]
  | (typeof EVENT_NAMES)['job'][keyof (typeof EVENT_NAMES)['job']]
  | (typeof EVENT_NAMES)['step'][keyof (typeof EVENT_NAMES)['step']]
  | (typeof EVENT_NAMES)['log'][keyof (typeof EVENT_NAMES)['log']]

export interface RedisKeyFactory {
  namespace: string
  idempotency(key: string): string
  concurrency(group: string): string
  run(runId: string): string
  artifacts(runId: string): string
  jobQueue(priority?: JobPriority): string
  runEvents(runId: string): string
  eventChannel(): string
  lock(name: string): string
}

export interface RedisKeyFactoryOptions {
  namespace?: string
}

export const DEFAULT_REDIS_NAMESPACE = 'kb'
export const WORKFLOW_REDIS_CHANNEL = 'kb:wf:events'

export function createRedisKeyFactory(
  options: RedisKeyFactoryOptions = {},
): RedisKeyFactory {
  const namespace =
    options.namespace?.replace(/[:\s]+/g, ':').replace(/:+$/, '') ||
    DEFAULT_REDIS_NAMESPACE
  const wfNs = `${namespace}:wf`

  return {
    namespace: wfNs,
    idempotency(key: string) {
      return `${wfNs}:idemp:${key}`
    },
    concurrency(group: string) {
      return `${wfNs}:conc:${group}`
    },
    run(runId: string) {
      return `${wfNs}:runs:${runId}`
    },
    artifacts(runId: string) {
      return `${wfNs}:artifacts:${runId}`
    },
    jobQueue(priority: JobPriority = 'normal') {
      return `${wfNs}:queue:jobs:${priority}`
    },
    runEvents(runId: string) {
      return `${wfNs}:events:runs:${runId}`
    },
    eventChannel() {
      return WORKFLOW_REDIS_CHANNEL
    },
    lock(name: string) {
      return `${wfNs}:locks:${name}`
    },
  }
}

export const IDEMPOTENCY_TTL_ENV = 'KB_WF_IDEMP_TTL_MS'
export const CONCURRENCY_TTL_ENV = 'KB_WF_CONC_TTL_MS'
export const REDIS_URL_ENV = 'KB_REDIS_URL'
export const REDIS_MODE_ENV = 'KB_REDIS_MODE'
export const REDIS_NAMESPACE_ENV = 'KB_REDIS_NAMESPACE'

export type RedisMode = 'standalone' | 'cluster' | 'sentinel'


