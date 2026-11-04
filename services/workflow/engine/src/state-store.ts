import type { JobRun, StepRun, WorkflowRun } from '@kb-labs/workflow-contracts'
import type { ICache, IStorage } from '@kb-labs/core-platform'
import {
  isActive,
  assertTransition,
  isTerminal,
  type AssertTransitionOptions,
} from '@kb-labs/workflow-constants'
import type { EngineLogger } from './types'
import { withLock } from './lock'

/**
 * How long a daemon's liveness claim on this shared state store stays valid
 * without a heartbeat renewal. This answers a completely different question
 * from `RUN_TTL_MS` above: not "is this run's data still around" but "is the
 * daemon that owns it still alive". `cleanupStaleRuns` uses ONLY this lease —
 * never a run's or job's own elapsed running time — to decide whether a
 * previous daemon instance is genuinely gone. A lease still on file this
 * recently can only mean some process wrote it within the last
 * DAEMON_LEASE_TTL_MS; if that process isn't the one calling
 * `cleanupStaleRuns`, force-failing "running"/"queued" jobs would very likely
 * be abandoning work a still-live sibling instance owns, not cleaning up
 * after a dead one. Kept well short of RUN_TTL_MS on purpose — a run/job can
 * legitimately run for tens of minutes, but no legitimate single daemon
 * instance should ever go this long without renewing its own lease.
 */
export const DAEMON_LEASE_TTL_MS = 45_000 // 45s

/** How often a live daemon should call `writeDaemonLease` to keep its lease
 * fresh — comfortably under `DAEMON_LEASE_TTL_MS` so a normal GC pause or a
 * slow cache round-trip never lets the lease lapse on its own. */
export const DAEMON_LEASE_HEARTBEAT_INTERVAL_MS = 15_000 // 15s

const DAEMON_LEASE_KEY = 'kb:daemon:lease'

export interface DaemonLease {
  instanceId: string
  heartbeatAt: string
}

export interface ActiveWorkflowWork {
  runs: string[];
  jobs: string[];
}

export class StateStore {
  private readonly cache: ICache
  private readonly storage: IStorage

  constructor(
    cache: ICache,
    storage: IStorage,
    private readonly logger: EngineLogger,
  ) {
    this.cache = cache
    this.storage = storage
  }

  async saveRun(run: WorkflowRun): Promise<void> {
    const path = runRecordPath(run.id)
    this.logger.debug('Persisting workflow run', { runId: run.id, path })
    await this.storage.write(path, Buffer.from(JSON.stringify(run), 'utf8'))
    try {
      await this.cache.zadd('workflow:runs:index', new Date(run.createdAt).getTime(), run.id)
    } catch (error) {
      this.logger.warn('Failed to update workflow run index; storage record is durable', {
        runId: run.id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async getRun(runId: string): Promise<WorkflowRun | null> {
    const payload = await this.storage.read(runRecordPath(runId))
    if (!payload) {
      return null
    }
    try {
      const run: unknown = JSON.parse(payload.toString('utf8'))
      if (!run || typeof run !== 'object' || Array.isArray(run)
          || !('id' in run) || run.id !== runId || !('jobs' in run) || !Array.isArray(run.jobs)) {
        this.logger.error('Stored workflow run does not match its storage key', undefined, { runId })
        return null
      }
      return run as WorkflowRun
    } catch (error) {
      this.logger.error('Failed to parse stored workflow run', error instanceof Error ? error : undefined, {
        runId,
      })
      return null
    }
  }

  async deleteRun(runId: string): Promise<void> {
    await this.storage.delete(runRecordPath(runId))
    try {
      await this.cache.zrem('workflow:runs:index', runId)
    } catch (error) {
      this.logger.warn('Failed to remove workflow run from cache index', {
        runId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async getAllRunIds(): Promise<string[]> {
    const paths = await this.storage.list('workflows/')
    const ids = paths.flatMap((path) => {
      const match = /^workflows\/([^/]+)\.json$/.exec(path)
      return match?.[1] ? [match[1]] : []
    })
    let indexed: string[] = []
    try {
      indexed = [...new Set(await this.cache.zrangebyscore('workflow:runs:index', -Infinity, Infinity) ?? [])]
    } catch (error) {
      this.logger.warn('Failed to read workflow run cache index; rebuilding from storage', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
    if (indexed.length === ids.length && ids.every((id) => indexed.includes(id))) {
      return indexed
    }

    const records = await Promise.all(paths.flatMap((path) => {
      const match = /^workflows\/([^/]+)\.json$/.exec(path)
      if (!match?.[1]) { return [] }
      return [this.storage.read(path).then((payload) => {
        if (!payload) { return null }
        try {
          const run: unknown = JSON.parse(payload.toString('utf8'))
          // The platform core runtime has a separate workflow engine and may
          // use the shared `workflows/` prefix for its own run representation.
          // Only records with the daemon engine's jobs array belong in this
          // state store's history index.
          if (run && typeof run === 'object' && !Array.isArray(run) && !('jobs' in run)) {
            return null
          }
          if (!run || typeof run !== 'object' || Array.isArray(run)
              || !('id' in run) || run.id !== match[1]
              || !('createdAt' in run) || typeof run.createdAt !== 'string') {
            this.logger.error('Stored workflow run is missing history fields', undefined, { path })
            return null
          }
          return { id: match[1], createdAt: run.createdAt }
        } catch (error) {
          this.logger.error('Failed to parse stored workflow run', error instanceof Error ? error : undefined, { path })
          return null
        }
      })]
    }))
    const sorted = records
      .filter((record): record is { id: string; createdAt: string } => record !== null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    try {
      for (const id of indexed) { await this.cache.zrem('workflow:runs:index', id) }
      for (const record of sorted) {
        await this.cache.zadd('workflow:runs:index', new Date(record.createdAt).getTime(), record.id)
      }
    } catch (error) {
      this.logger.warn('Failed to rebuild workflow run cache index', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
    return sorted.map(({ id }) => id)
  }

  async listActiveWork(): Promise<ActiveWorkflowWork> {
    const runIds = await this.getAllRunIds()
    const runs = await Promise.all(runIds.map((id) => this.getRun(id)))
    const activeRuns: string[] = []
    const activeJobs: string[] = []
    for (const run of runs) {
      if (!run) { continue }
      if (isActive(run.status, 'run')) { activeRuns.push(run.id) }
      for (const job of run.jobs) {
        if (isActive(job.status, 'job')) { activeJobs.push(job.id) }
      }
    }
    return { runs: activeRuns.sort(), jobs: activeJobs.sort() }
  }

  /**
   * Read the current daemon liveness lease, if one is still on file. Returns
   * null both when no daemon has ever written one and when the last writer's
   * lease has expired (per `DAEMON_LEASE_TTL_MS`) — the cache backend itself
   * enforces that expiry, so a non-null result here is proof some process
   * heartbeated within the last `DAEMON_LEASE_TTL_MS`.
   */
  async getDaemonLease(): Promise<DaemonLease | null> {
    const raw = await this.cache.get<string>(DAEMON_LEASE_KEY)
    if (!raw) {
      return null
    }
    try {
      return JSON.parse(raw) as DaemonLease
    } catch (error) {
      this.logger.error('Failed to parse stored daemon lease', error instanceof Error ? error : undefined)
      return null
    }
  }

  /**
   * Claim (or renew) the daemon liveness lease under `instanceId`, valid for
   * `DAEMON_LEASE_TTL_MS`. Called once at startup after `cleanupStaleRuns`
   * decides this instance is safe to proceed as the active daemon, and then
   * periodically for as long as the daemon stays up, so its lease never
   * lapses while it's genuinely alive.
   */
  async writeDaemonLease(instanceId: string): Promise<void> {
    const lease: DaemonLease = { instanceId, heartbeatAt: new Date().toISOString() }
    await this.cache.set(DAEMON_LEASE_KEY, JSON.stringify(lease), DAEMON_LEASE_TTL_MS)
  }

  /**
   * Holds an exclusive per-run lock (see `withLock`) for the whole
   * read-modify-write, so `mutator` runs exactly once per call — no other
   * writer can observe or clobber the run in between. This is what actually
   * fixes the original bug class (a job marked `failed` while its step was
   * mid-write to `waiting_approval`): the two writes can no longer interleave.
   *
   * `mutator` must still not `await` — it runs synchronously against a
   * single in-memory draft while the lock is held; async work belongs after
   * `updateRun` resolves (and holding the lock across an `await` would just
   * make every other writer to this run block on it needlessly).
   */
  async updateRun(
    runId: string,
    mutator: (draft: WorkflowRun) => WorkflowRun | void,
  ): Promise<WorkflowRun | null> {
    return this.updateRunRecord(runId, mutator, false)
  }

  private async updateRunRecord(
    runId: string,
    mutator: (draft: WorkflowRun) => WorkflowRun | void,
    terminalTransitionOwner: boolean,
  ): Promise<WorkflowRun | null> {
    return withLock(this.cache, `kb:lock:run:${runId}`, async () => {
      const run = await this.getRun(runId)
      if (!run) {
        return null
      }

      const draft = clone(run)
      draft.eventSequence = run.eventSequence + 1
      const result = mutator(draft)
      const next = (result ?? draft) as WorkflowRun
      if (!terminalTransitionOwner && run.status !== next.status && isTerminal(next.status, 'run')) {
        throw new Error(`Workflow run status "${next.status}" can only be written by the terminal transition owner`)
      }
      await this.saveRun(next)
      return next
    })
  }

  async updateJob(
    runId: string,
    jobId: string,
    mutator: (job: JobRun) => JobRun | void,
  ): Promise<JobRun | null> {
    let updatedJob: JobRun | null = null

    await this.updateRun(runId, (run) => {
      const index = run.jobs.findIndex((job: JobRun) => job.id === jobId)
      if (index === -1) {
        return
      }
      const existingJob = run.jobs[index]
      if (!existingJob) {
        return
      }
      const jobDraft = clone(existingJob)
      const result = mutator(jobDraft)
      const nextJob = (result ?? jobDraft) as JobRun
      nextJob.eventSequence = run.eventSequence
      run.jobs[index] = nextJob
      updatedJob = nextJob
    })

    return updatedJob
  }

  async updateStep(
    runId: string,
    jobId: string,
    stepId: string,
    mutator: (step: StepRun) => StepRun | void,
  ): Promise<StepRun | null> {
    let updatedStep: StepRun | null = null

    await this.updateRun(runId, (run) => {
      const jobIndex = run.jobs.findIndex((job) => job.id === jobId)
      if (jobIndex === -1) {
        return
      }
      const job = run.jobs[jobIndex]
      if (!job) {
        return
      }
      const stepIndex = job.steps.findIndex(
        (step: StepRun) => step.id === stepId,
      )
      if (stepIndex === -1) {
        return
      }
      const existingStep = job.steps[stepIndex]
      if (!existingStep) {
        return
      }
      const draft = clone(existingStep)
      const result = mutator(draft)
      const nextStep = (result ?? draft) as StepRun
      nextStep.eventSequence = run.eventSequence
      job.steps[stepIndex] = nextStep
      updatedStep = nextStep
    })

    return updatedStep
  }

  /**
   * Like `updateRun`, but validates the status transition against the
   * workflow state machine before applying it — throws
   * `IllegalStateTransitionError` (from `@kb-labs/workflow-constants`) if
   * `to` is not reachable from the run's current status. `mutate` sets any
   * *other* fields; it must not itself assign `.status` (this method owns
   * that assignment, after the check).
   */
  async transitionRun(
    runId: string,
    to: WorkflowRun['status'],
    mutate: (draft: WorkflowRun) => void = () => {},
    options?: AssertTransitionOptions,
  ): Promise<WorkflowRun | null> {
    return this.updateRunRecord(runId, (draft) => {
      assertTransition('run', draft.status, to, options)
      draft.status = to
      mutate(draft)
    }, isTerminal(to, 'run'))
  }

  /** Job-level counterpart of `transitionRun` — see its docblock. */
  async transitionJob(
    runId: string,
    jobId: string,
    to: JobRun['status'],
    mutate: (draft: JobRun) => void = () => {},
    options?: AssertTransitionOptions,
  ): Promise<JobRun | null> {
    return this.updateJob(runId, jobId, (draft) => {
      assertTransition('job', draft.status, to, options)
      draft.status = to
      mutate(draft)
    })
  }

  /** Step-level counterpart of `transitionRun` — see its docblock. */
  async transitionStep(
    runId: string,
    jobId: string,
    stepId: string,
    to: StepRun['status'],
    mutate: (draft: StepRun) => void = () => {},
    options?: AssertTransitionOptions,
  ): Promise<StepRun | null> {
    return this.updateStep(runId, jobId, stepId, (draft) => {
      assertTransition('step', draft.status, to, options)
      draft.status = to
      mutate(draft)
    })
  }

  async resolveBlockedJobs(
    runId: string,
    upstreamJobName: string,
    resolution: { outcome: 'success' } | { outcome: 'failure'; reason: string },
  ): Promise<JobRun[]> {
    let resolved: JobRun[] = []

    await this.updateRun(runId, (run) => {
      resolved = []
      if (resolution.outcome === 'success') {
        for (const job of run.jobs) {
          if (job.status !== 'queued' || !job.blocked || !job.needs?.includes(upstreamJobName)) { continue }
          const pending = job.pendingDependencies ?? []
          const remaining = pending.filter((dependency) => dependency !== upstreamJobName)
          if (remaining.length === pending.length) { continue }
          job.pendingDependencies = remaining
          if (remaining.length === 0) {
            job.blocked = false
            resolved.push(clone(job))
          }
        }
        return
      }

      const failedNames = new Set([upstreamJobName])
      let changed = true
      const finishedAt = new Date().toISOString()
      while (changed) {
        changed = false
        for (const job of run.jobs) {
          if (job.status !== 'queued' || !job.blocked || !job.needs?.some((name) => failedNames.has(name))) { continue }
          job.status = 'cancelled'
          job.blocked = false
          job.finishedAt = finishedAt
          job.error = { message: resolution.reason, timestamp: finishedAt }
          failedNames.add(job.jobName)
          resolved.push(clone(job))
          changed = true
        }
      }
    })

    return resolved
  }
}

function runRecordPath(runId: string): string {
  if (!runId || runId.includes('/') || runId.includes('\\') || runId === '.' || runId === '..') {
    throw new Error(`Invalid workflow run ID: ${runId}`)
  }
  return `workflows/${runId}.json`
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
