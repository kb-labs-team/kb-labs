import type { JobRun, WorkflowRun } from '@kb-labs/workflow-contracts'
import type { JobPriority } from '@kb-labs/workflow-constants'
import type { ICache } from '@kb-labs/core-platform'
import type { EngineLogger } from './types'
import { withLock } from './lock'

export interface JobQueueEntry {
  id: string
  runId: string
  jobId: string
  priority: JobPriority
  enqueuedAt: string
  availableAt: number
  jobName: string
}

export interface SchedulerOptions {
  defaultPriority?: JobPriority
  lookAheadMs?: number
}

export class Scheduler {
  private readonly cache: ICache
  private readonly defaultPriority: JobPriority
  private readonly lookAheadMs: number
  private readonly priorityOrder: JobPriority[] = ['high', 'normal', 'low']

  constructor(
    cache: ICache,
    private readonly logger: EngineLogger,
    options: SchedulerOptions = {},
  ) {
    this.cache = cache
    this.defaultPriority = options.defaultPriority ?? 'normal'
    this.lookAheadMs = options.lookAheadMs ?? 1000
  }

  async scheduleRun(run: WorkflowRun): Promise<void> {
    // Enqueue ready jobs in parallel
    const readyJobs = run.jobs.filter(job => {
      if (job.blocked) {
        this.logger.debug('Job blocked by dependencies; deferring enqueue', {
          runId: run.id,
          jobId: job.id,
          needs: job.needs,
        })
        return false
      }
      return true
    })

    await Promise.all(
      readyJobs.map(job => {
        const priority = job.priority ?? this.defaultPriority
        return this.enqueueJob(run.id, job, priority)
      }),
    )
  }

  async enqueueJob(
    runId: string,
    job: JobRun,
    priority: JobPriority = this.defaultPriority,
  ): Promise<void> {
    if (job.blocked) {
      this.logger.debug('Skipping enqueue for blocked job', {
        runId,
        jobId: job.id,
        needs: job.pendingDependencies,
      })
      return
    }
    const now = Date.now()
    const entryId = `${runId}:${job.id}:${now}:${Math.random().toString(36).slice(2, 10)}`
    const entry: JobQueueEntry = {
      id: entryId,
      runId,
      jobId: job.id,
      jobName: job.jobName,
      priority,
      enqueuedAt: new Date().toISOString(),
      availableAt: now,
    }
    await this.cache.zadd(
      `kb:jobqueue:${priority}`,
      entry.availableAt,
      JSON.stringify(entry),
    )
    this.logger.debug('Job enqueued', { runId, jobId: job.id, priority })
  }

  async dequeueJob(): Promise<JobQueueEntry | null> {
    // Sequential check by priority order - must return first match respecting priority
    for (const priority of this.priorityOrder) {
      const entry = await this.dequeueFromPriority(priority) // eslint-disable-line no-await-in-loop
      if (entry) {
        return entry
      }
    }
    return null
  }

  async reschedule(entry: JobQueueEntry, delayMs: number): Promise<void> {
    const availableAt = Date.now() + delayMs
    const next: JobQueueEntry = {
      ...entry,
      availableAt,
      enqueuedAt: new Date().toISOString(),
    }
    await this.cache.zadd(
      `kb:jobqueue:${entry.priority}`,
      availableAt,
      JSON.stringify(next),
    )
    this.logger.debug('Job rescheduled', {
      runId: entry.runId,
      jobId: entry.jobId,
      delayMs,
      priority: entry.priority,
    })
  }

  /**
   * The read (`zrangebyscore`) and the remove (`zrem`) below are two
   * separate cache round-trips, not one atomic op — without the lock, two
   * daemon instances racing this method could both read the same top entry
   * before either removes it, and both would go on to execute the same job
   * (the daemon runs multiple instances in production, so this is a live
   * bug, not a theoretical one). `withLock` serializes dequeues against this
   * one priority queue across every process sharing the same cache backend,
   * the same way `StateStore.updateRun` serializes writes to one run.
   */
  private async dequeueFromPriority(priority: JobPriority): Promise<JobQueueEntry | null> {
    const key = `kb:jobqueue:${priority}`
    const eligibleEntries = await this.cache.zrangebyscore(
      key,
      0,
      Date.now() + this.lookAheadMs,
    )
    if (eligibleEntries.length === 0) {
      return null
    }

    return withLock(this.cache, `kb:lock:queue:${priority}`, async () => {
      const now = Date.now()
      const results = await this.cache.zrangebyscore(
        key,
        0,
        now + this.lookAheadMs,
      )

      // Handle LIMIT manually - take only first result
      if (results.length === 0) {
        return null
      }

      const raw = results[0]
      if (typeof raw !== 'string') {
        return null
      }
      try {
        const entry = JSON.parse(raw) as JobQueueEntry
        await this.cache.zrem(key, raw)
        return entry
      } catch (error) {
        this.logger.error('Failed to parse job queue entry', error instanceof Error ? error : undefined)
        return null
      }
    })
  }

  getDefaultPriority(): JobPriority {
    return this.defaultPriority
  }
}

