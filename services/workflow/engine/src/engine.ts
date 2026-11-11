import { randomUUID } from 'node:crypto'
import type {
  WorkflowRun,
  WorkflowSpec,
  JobRun,
  StepRun,
  ExpressionContext,
} from '@kb-labs/workflow-contracts'
import { evaluateExpression, requireWorkflowId, resolveExpression } from '@kb-labs/workflow-contracts'
import {
  EVENT_NAMES,
  WORKFLOW_REDIS_CHANNEL,
  IllegalStateTransitionError,
  isTerminal,
  assertTransition,
  type WorkflowEventName,
  type TerminalRunState,
} from '@kb-labs/workflow-constants'
import type { ICache, IStorage, IEventBus, ILogger, IAnalytics, ISnapshotManager, Unsubscribe } from '@kb-labs/core-platform'
import type { ClassifiedFailure, RetryPolicyConfig } from '@kb-labs/core-contracts'
import { classifyFailure, decideRetry } from '@kb-labs/core-retry'
import { StateStore } from './state-store'
import { ConcurrencyManager, type AcquireOptions } from './concurrency-manager'
import {
  RunCoordinator,
  type RunCoordinatorOptions,
} from './run-coordinator'
import {
  Scheduler,
  type SchedulerOptions,
  type JobQueueEntry,
} from './scheduler'
import { EventBusBridge, type WorkflowEvent } from './event-bus'
import { WorkflowLoader } from './workflow-loader'
import type { SecretProvider } from './secrets'
import type { CreateRunInput, EngineLogger, RunContext } from './types'
import { RunSnapshotStorage, type RunSnapshot } from './run-snapshot'
import { ProjectScopedCache } from './project-scoped-cache'
import { workflowDeadLetterCacheKey } from './dead-letter-key'

export interface WorkflowAncillaryFailure {
  operation: string
  runId: string
  jobId?: string
  message: string
}

export interface WorkflowOperationResult {
  ancillaryFailures: WorkflowAncillaryFailure[]
}

export interface WorkflowEngineOptions {
  /** Registered project identity supplied by the project runtime. */
  projectId: string
  scheduler?: SchedulerOptions
  concurrency?: AcquireOptions
  runCoordinator?: RunCoordinatorOptions
  maxWorkflowDepth?: number
  /** Platform cache adapter (REQUIRED) */
  cache: ICache
  /** Project storage adapter (REQUIRED) — durable workflow run records */
  storage: IStorage
  /** Platform event bus adapter (REQUIRED) */
  events: IEventBus
  /** Platform logger (REQUIRED) */
  logger: ILogger
  /** Secret source used to validate workflows and resolve declared values. */
  secretProvider: SecretProvider
  /** Platform analytics adapter (OPTIONAL) */
  analytics?: IAnalytics
  /** Platform snapshot manager (OPTIONAL - for infra snapshot rollback in replay) */
  snapshotManager?: ISnapshotManager
  /** Workspace root (monorepo root) - used for plugin execution context */
  workspaceRoot?: string
  /**
   * Unique identifier for this daemon/engine process, used by
   * `cleanupStaleRuns` to tell "genuinely a different daemon instance" apart
   * from "this same instance calling in again". Defaults to a fresh
   * `randomUUID()` per engine — override only in tests that need to assert
   * on a known id or simulate two instances against the same store.
   */
  instanceId?: string
}

export class WorkflowEngine {
  readonly loader: WorkflowLoader
  readonly maxWorkflowDepth: number
  /** See `WorkflowEngineOptions.instanceId`. */
  readonly instanceId: string
  readonly secretProvider: SecretProvider

  private readonly logger: EngineLogger
  private readonly analytics?: IAnalytics
  private readonly stateStore: StateStore
  private readonly concurrency: ConcurrencyManager
  private readonly runCoordinator: RunCoordinator
  private readonly scheduler: Scheduler
  private readonly events: EventBusBridge
  private readonly snapshotStorage: RunSnapshotStorage
  private readonly options: WorkflowEngineOptions

  constructor(options: WorkflowEngineOptions) {
    const projectCache = new ProjectScopedCache(options.cache, options.projectId)
    this.options = { ...options, cache: projectCache }
    this.logger = options.logger
    this.analytics = options.analytics
    this.instanceId = options.instanceId ?? randomUUID()
    this.secretProvider = options.secretProvider

    this.stateStore = new StateStore(projectCache, options.storage, this.logger)
    this.concurrency = new ConcurrencyManager(
      projectCache,
      this.logger,
      options.concurrency,
    )
    this.runCoordinator = new RunCoordinator(
      projectCache,
      this.stateStore,
      this.concurrency,
      this.logger,
      options.runCoordinator,
    )

    this.scheduler = new Scheduler(projectCache, this.logger, options.scheduler)
    this.events = new EventBusBridge(options.events, this.logger)
    this.loader = new WorkflowLoader(this.logger, this.secretProvider)
    this.maxWorkflowDepth = options.maxWorkflowDepth ?? 2
    this.snapshotStorage = new RunSnapshotStorage(projectCache, this.logger)
  }

  async dispose(): Promise<void> {
    // Cleanup if needed
  }

  private async runAncillaryOperation(
    runId: string,
    jobId: string,
    operation: string,
    action: () => Promise<void>,
    failures: WorkflowAncillaryFailure[] = [],
  ): Promise<WorkflowAncillaryFailure | null> {
    try {
      await action()
      return null
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error))
      this.logger.error(
        'Workflow ancillary operation failed',
        normalizedError,
        { operation, runId, jobId },
      )
      const failure = { operation, runId, jobId, message: normalizedError.message }
      failures.push(failure)
      try {
        await this.stateStore.updateRun(runId, (draft) => {
          draft.diagnostics = [...(draft.diagnostics ?? []), { ...failure, recordedAt: new Date().toISOString() }]
        })
      } catch (persistError) {
        const diagnosticError = persistError instanceof Error ? persistError : new Error(String(persistError))
        this.logger.error('Workflow ancillary diagnostic persistence failed', diagnosticError, {
          operation: 'run.diagnostics.persist', runId, jobId,
        })
        failures.push({ operation: 'run.diagnostics.persist', runId, jobId, message: diagnosticError.message })
      }
      return failure
    }
  }

  private async transitionRunTerminal(
    runId: string,
    status: TerminalRunState,
    mutate: (run: WorkflowRun) => WorkflowRun | void,
  ): Promise<WorkflowRun | null> {
    if (!isTerminal(status, 'run')) {
      throw new Error(`Workflow run terminal owner cannot persist non-terminal status "${status}"`)
    }
    const updated = await this.stateStore.transitionRun(runId, status, mutate)
    if (updated) {
      this.logger.info('Workflow run terminal state persisted', { runId, status })
    }
    return updated
  }

  /**
   * Subscribe to real-time events for a specific workflow run.
   * Events are filtered by runId from the shared event bus channel.
   */
  subscribeToRunEvents(
    runId: string,
    handler: (event: WorkflowEvent) => void,
  ): Unsubscribe {
    return this.options.events.subscribe(WORKFLOW_REDIS_CHANNEL, async (raw: unknown) => {
      const event = raw as WorkflowEvent
      if (event.runId === runId) {handler(event)}
    })
  }

  private async publishEvent(
    event: Omit<WorkflowEvent, 'sequence'>,
    sequence?: number,
  ): Promise<void> {
    if (sequence !== undefined) {
      await this.events.publish({ ...event, sequence })
      return
    }
    const run = await this.stateStore.getRun(event.runId)
    if (!run) {
      throw new Error(`Cannot publish workflow event for missing run ${event.runId}`)
    }
    await this.events.publish({ ...event, sequence: run.eventSequence })
  }

  async createRun(input: CreateRunInput): Promise<WorkflowRun> {
    const run = await this.runCoordinator.ensureRun(input)

    // Track workflow run creation
    this.analytics?.track('workflow.run.created', {
      runId: run.id,
      name: run.name,
      version: run.version,
      jobCount: run.jobs.length,
      trigger: input.trigger?.type,
    }).catch(() => {}) // Silent fail for analytics

    await this.publishEvent({
      type: EVENT_NAMES.run.created,
      runId: run.id,
      payload: {
        status: run.status,
        name: run.name,
        version: run.version,
      },
    })
    await this.scheduler.scheduleRun(run)

    return run
  }

  async runFromSpec(
    spec: WorkflowSpec,
    input: Omit<CreateRunInput, 'spec'>,
  ): Promise<WorkflowRun> {
    return this.createRun({
      ...input,
      spec,
    })
  }

  async runFromFile(
    filePath: string,
    input: Omit<CreateRunInput, 'spec'>,
  ): Promise<WorkflowRun> {
    const result = await this.loader.fromFile(filePath)
    return this.runFromSpec(result.spec, input)
  }

  async runFromInline(
    spec: unknown,
    input: Omit<CreateRunInput, 'spec'>,
  ): Promise<WorkflowRun> {
    const result = this.loader.fromInline(spec)
    return this.runFromSpec(result.spec, input)
  }

  async getRun(runId: string): Promise<WorkflowRun | null> {
    return this.stateStore.getRun(runId)
  }

  async cancelRun(runId: string): Promise<WorkflowOperationResult> {
    const ancillaryFailures: WorkflowAncillaryFailure[] = []
    const run = await this.getRun(runId)
    if (!run) {
      return { ancillaryFailures }
    }

    try {
      await this.transitionRunTerminal(runId, 'cancelled', (draft) => {
        draft.finishedAt = new Date().toISOString()
      })
    } catch (error) {
      // Already terminal (or otherwise unreachable from its current status)
      // — a no-op, same as the old up-front status check, except the check
      // now happens inside the lock against the live record instead of
      // racing a stale read taken before it.
      if (error instanceof IllegalStateTransitionError) {
        return { ancillaryFailures }
      }
      throw error
    }

    // Track workflow cancellation
    await this.runAncillaryOperation(runId, '', 'analytics.run.cancelled', async () => {
      await this.analytics?.track('workflow.run.cancelled', {
        runId, name: run.name, reason: 'cancelled by parent workflow',
      })
    }, ancillaryFailures)

    await this.runAncillaryOperation(runId, '', 'event.publish.run.cancelled', () => this.publishEvent({
      type: EVENT_NAMES.run.cancelled,
      runId,
      payload: { reason: 'cancelled by parent workflow' },
    }), ancillaryFailures)

    // Invocation links are persisted on child trigger metadata, so cancellation
    // survives worker/daemon restarts and naturally cascades through descendants.
    const descendants = await this.findChildRuns(runId)
    const childResults = await Promise.all(descendants.map((child) => this.cancelRun(child.id)))
    ancillaryFailures.push(...childResults.flatMap((result) => result.ancillaryFailures))
    await this.runAncillaryOperation(runId, '', 'workflow.child.reconcile', async () => {
      await this.reconcileChildInvocation(runId)
    }, ancillaryFailures)
    return { ancillaryFailures }
  }

  /**
   * Reconcile all persisted parent/child links. This is deliberately engine-side
   * instead of a worker-local polling task: it is safe to call after a daemon
   * restart and is idempotent when several reconciliations race.
   */
  async reconcileChildInvocations(): Promise<number> {
    const runs = await this.listStoredRuns()
    let reconciled = 0

    for (const parent of runs) {
      for (const job of parent.jobs) {
        for (const step of job.steps) {
          if (step.status !== 'waiting_child') {continue}
          const childRunId = step.metadata?.['childRunId']
          if (typeof childRunId !== 'string') {continue}

          const child = await this.getRun(childRunId)
          if (parent.status === 'cancelled') {
            if (child) {await this.cancelRun(child.id)}
            continue
          }
          if (!child) {
            await this.failChildInvocation(parent.id, job.id, step.id, childRunId, 'not found')
            reconciled++
            continue
          }
          if (!['success', 'failed', 'cancelled', 'skipped', 'dlq'].includes(child.status)) {
            continue
          }
          if (child.status === 'success') {
            const outputs = this.childResultEnvelope(child)
            await this.markStepCompleted(parent.id, job.id, step.id, outputs)
            await this.resumeJob(parent.id, job.id)
          } else {
            await this.failChildInvocation(parent.id, job.id, step.id, child.id, child.status)
          }
          reconciled++
        }
      }
    }
    return reconciled
  }

  /** Run reconciliation on terminal-child events; startup calls it once too. */
  async reconcileChildInvocation(childRunId: string): Promise<number> {
    const parents = (await this.listStoredRuns()).filter((run) =>
      run.jobs.some((job) => job.steps.some((step) =>
        step.status === 'waiting_child' && step.metadata?.['childRunId'] === childRunId,
      )),
    )
    if (parents.length === 0) {return 0}
    return this.reconcileChildInvocations()
  }

  private childResultEnvelope(child: WorkflowRun): Record<string, unknown> {
    const stepOutputs: Record<string, Record<string, unknown>> = {}
    for (const job of child.jobs) {
      for (const step of job.steps) {
        if (step.status === 'success' && step.spec.id && step.outputs) {
          stepOutputs[step.spec.id] = step.outputs
        }
      }
    }
    return {
      runId: child.id,
      status: child.status,
      outputs: Object.keys(child.result?.outputs ?? {}).length > 0
        ? child.result?.outputs
        : stepOutputs,
      artifacts: child.artifacts ?? [],
    }
  }

  private resolveDeclaredOutputs(run: WorkflowRun): Record<string, unknown> {
    const declarations = run.metadata?.outputDeclarations
    if (!declarations) {return {}}
    const context = this.buildExpressionContext(run)
    return Object.fromEntries(Object.entries(declarations).map(([name, declaration]) => {
      const source = declaration && typeof declaration === 'object'
        ? (declaration as { source?: unknown }).source
        : undefined
      return [name, typeof source === 'string' ? resolveExpression(source, context) : undefined]
    }))
  }

  private async failChildInvocation(
    parentRunId: string,
    parentJobId: string,
    parentStepId: string,
    childRunId: string,
    childStatus: string,
  ): Promise<void> {
    const error = new Error(`Child workflow ${childStatus} (run ${childRunId})`)
    await this.markStepFailed(parentRunId, parentJobId, parentStepId, error, {
      runId: childRunId,
      status: childStatus,
    })
    await this.markJobFailed(parentRunId, parentJobId, error, undefined, false)
  }

  private async listStoredRuns(): Promise<WorkflowRun[]> {
    const runIds = await this.stateStore.getAllRunIds()
    // Cache sorted-set adapters are permitted to retain duplicate members on
    // repeated saveRun calls. Reconciliation must be exactly-once per durable
    // run record even when event/index delivery is at-least-once.
    const runs = await Promise.all([...new Set(runIds)].map((id) => this.getRun(id)))
    return runs.filter((run): run is WorkflowRun => run !== null)
  }

  private async findChildRuns(parentRunId: string): Promise<WorkflowRun[]> {
    return (await this.listStoredRuns()).filter((run) =>
      run.trigger.parentRunId === parentRunId || run.metadata?.parentRunId === parentRunId,
    )
  }

  /**
   * Mark job as failed and optionally schedule retry.
   * Implements exponential/linear backoff retry logic.
   */
  async markJobFailed(
    runId: string,
    jobId: string,
    error: Error & { code?: string; hint?: string; details?: Record<string, unknown> },
    failure?: ClassifiedFailure,
    policyOverride?: false | { max: number; backoff?: 'exp' | 'lin'; initialIntervalMs?: number; maxIntervalMs?: number; on?: string[] }
  ): Promise<WorkflowOperationResult> {
    const ancillaryFailures: WorkflowAncillaryFailure[] = []
    const run = await this.stateStore.getRun(runId)
    if (!run) {
      this.logger.warn('Cannot mark job as failed: run not found', { runId, jobId })
      return { ancillaryFailures }
    }

    const job = run.jobs.find((j) => j.id === jobId)
    if (!job) {
      this.logger.warn('Cannot mark job as failed: job not found', { runId, jobId })
      return { ancillaryFailures }
    }

    // Update job status to failed
    await this.stateStore.transitionJob(runId, jobId, 'failed', (draft) => {
      draft.error = {
        message: error.message,
        code: error.code,
        hint: error.hint,
        details: error.details,
        stack: error.stack,
        timestamp: new Date().toISOString(),
      }
      draft.finishedAt = new Date().toISOString()
      draft.attempt = (draft.attempt || 0) + 1
    })

    const classified = failure ?? classifyFailure(error, { source: 'execution', phase: 'response' })
    const retryConfig: RetryPolicyConfig | undefined = policyOverride !== undefined && typeof policyOverride !== 'boolean'
      ? {
          maxAttempts: policyOverride.max + 1,
          retryOn: (policyOverride.on ?? ['command', 'network', 'timeout', 'rate_limit', 'server', 'infrastructure']) as RetryPolicyConfig['retryOn'],
          initialDelayMs: policyOverride.initialIntervalMs ?? 1000,
          backoff: policyOverride.backoff === 'lin' ? 'linear' : 'exponential',
          maxDelayMs: policyOverride.maxIntervalMs ?? 30_000,
          respectRetryAfter: true,
          requireIdempotencyForUnsafeFailures: true,
        }
      : undefined
    const retryDecision = policyOverride === false
      ? { retry: false, reason: 'policy_denied' as const, delayMs: 0 }
      : retryConfig
      ? decideRetry({ failure: classified, attempt: job.attempt || 0, policy: retryConfig })
      : decideRetry({ failure: classified, attempt: job.attempt || 0 })

    // Check if should retry
    if (retryDecision.retry) {
      const backoffMs = retryDecision.delayMs
      // Re-queue job after backoff
      setTimeout(async () => {
        await this.runAncillaryOperation(runId, jobId, 'scheduler.retry', async () => {
          try {
            await this.stateStore.transitionJob(runId, jobId, 'queued', (draft) => {
              draft.error = undefined
              draft.startedAt = undefined
              draft.finishedAt = undefined
            })
          } catch (transitionError) {
            if (transitionError instanceof IllegalStateTransitionError) {
              this.logger.info('Dropping stale job retry: job is no longer failed', { runId, jobId })
              return
            }
            throw transitionError
          }

          const updatedRun = await this.stateStore.getRun(runId)
          const updatedJob = updatedRun?.jobs.find((candidate) => candidate.id === jobId)
          if (updatedJob) {
            await this.scheduler.enqueueJob(runId, updatedJob, updatedJob.priority ?? 'normal')
          }
          this.logger.info('Job re-queued for retry', { runId, jobId })
        }, ancillaryFailures)
      }, backoffMs)

      this.logger.error('Job failed', error, { runId, jobId, attempt: (job.attempt || 0) + 1 })
      await this.runAncillaryOperation(runId, jobId, 'analytics.job.failed', async () => {
        await this.analytics?.track('workflow.job.failed', {
          runId, jobId, jobName: job.jobName, attempt: (job.attempt || 0) + 1,
          errorMessage: error.message, willRetry: true, failureKind: classified.kind, failureCode: classified.code,
        })
      }, ancillaryFailures)
      await this.runAncillaryOperation(runId, jobId, 'event.publish.job.failed', () => this.publishEvent({
        type: EVENT_NAMES.job.failed,
        runId,
        jobId,
        payload: { jobName: job.jobName, error: error.message, attempt: (job.attempt || 0) + 1 },
      }), ancillaryFailures)
      this.logger.info('Scheduling job retry', { runId, jobId, attempt: (job.attempt || 0) + 1, backoffMs })
    } else {
      await this.checkRunCompletion(runId, jobId, ancillaryFailures)
      this.logger.error('Job failed', error, { runId, jobId, attempt: (job.attempt || 0) + 1 })
      await this.runAncillaryOperation(runId, jobId, 'analytics.job.failed', async () => {
        await this.analytics?.track('workflow.job.failed', {
          runId, jobId, jobName: job.jobName, attempt: (job.attempt || 0) + 1,
          errorMessage: error.message, willRetry: false, failureKind: classified.kind, failureCode: classified.code,
        })
      }, ancillaryFailures)
      await this.runAncillaryOperation(runId, jobId, 'event.publish.job.failed', () => this.publishEvent({
        type: EVENT_NAMES.job.failed,
        runId,
        jobId,
        payload: { jobName: job.jobName, error: error.message, attempt: (job.attempt || 0) + 1 },
      }), ancillaryFailures)
      let cancelledJobs: Array<{ jobId: string; jobName: string; reason: string }> = []
      await this.runAncillaryOperation(runId, jobId, 'workflow.jobs.cancel-downstream', async () => {
        cancelledJobs = await this.cancelDownstreamJobs(runId, job.jobName, `upstream job "${job.jobName}" failed`)
      }, ancillaryFailures)
      for (const cancelledJob of cancelledJobs) {
        await this.runAncillaryOperation(runId, cancelledJob.jobId, 'event.publish.job.cancelled', () => this.publishEvent({
          type: EVENT_NAMES.job.cancelled,
          runId,
          jobId: cancelledJob.jobId,
          payload: { jobName: cancelledJob.jobName, reason: cancelledJob.reason },
        }), ancillaryFailures)
      }
      await this.runAncillaryOperation(runId, jobId, 'cache.dead-letter.set', () => this.deadLetterJob(runId, jobId, error), ancillaryFailures)
    }
    return { ancillaryFailures }
  }

  /**
   * Recursively cancel jobs blocked on a failed/cancelled upstream job, so the
   * DAG does not leave dependents stuck in 'queued'. Cancellation cascades:
   * a cancelled job also cancels its own dependents.
   */
  private async cancelDownstreamJobs(
    runId: string,
    failedJobName: string,
    reason: string,
  ): Promise<Array<{ jobId: string; jobName: string; reason: string }>> {
    const cancelled = await this.stateStore.resolveBlockedJobs(runId, failedJobName, { outcome: 'failure', reason })
    return cancelled.map((job) => ({ jobId: job.id, jobName: job.jobName, reason }))
  }

  /**
   * Mark job as interrupted (e.g., during graceful shutdown).
   * Interrupted jobs will be retried on next daemon startup.
   */
  async markJobInterrupted(runId: string, jobId: string): Promise<void> {
    await this.stateStore.transitionJob(runId, jobId, 'interrupted', (draft) => {
      draft.finishedAt = new Date().toISOString()
    })

    this.logger.warn('Job interrupted', { runId, jobId })
  }

  /**
   * Mark job as started (running).
   */
  async markJobStarted(runId: string, jobId: string): Promise<void> {
    await this.stateStore.transitionJob(runId, jobId, 'running', (draft) => {
      draft.startedAt = new Date().toISOString()
    })

    // Promote run status to 'running' when first job starts. Deliberately
    // NOT `transitionRun` here: this is an opportunistic "if still queued,
    // promote" check, not an assertion that the run must currently be
    // 'queued' — the run may already be 'running' (a later job in the same
    // run starting) or, more rarely, something else entirely, and both
    // should stay a silent no-op rather than throw.
    await this.stateStore.updateRun(runId, (draft) => {
      if (draft.status === 'queued') {
        draft.status = 'running'
        if (!draft.startedAt) {
          draft.startedAt = new Date().toISOString()
        }
      }
    })

    this.logger.info('Job started', { runId, jobId })

    // Track job start
    const run = await this.getRun(runId)
    const job = run?.jobs.find((j) => j.id === jobId)
    this.analytics?.track('workflow.job.started', {
      runId,
      jobId,
      jobName: job?.jobName,
      stepCount: job?.steps.length ?? 0,
    }).catch(() => {})

    await this.publishEvent({
      type: EVENT_NAMES.job.started,
      runId,
      jobId,
      payload: { jobName: job?.jobName },
    })
  }

  /**
   * Mark job as completed successfully.
   */
  async markJobCompleted(runId: string, jobId: string): Promise<WorkflowOperationResult> {
    const ancillaryFailures: WorkflowAncillaryFailure[] = []
    const run = await this.getRun(runId)
    const job = run?.jobs.find((j) => j.id === jobId)
    const startTime = job?.startedAt ? new Date(job.startedAt).getTime() : Date.now()
    const duration = Date.now() - startTime

    await this.stateStore.transitionJob(runId, jobId, 'success', (draft) => {
      draft.finishedAt = new Date().toISOString()
    })
    const dispatch = { jobs: [] as JobRun[], skipped: [] as JobRun[] }
    if (job?.jobName) {
      const run = await this.stateStore.getRun(runId)
      const exprCtx = this.buildExpressionContext(run)
      await this.persistSuccessfulDependents(runId, job, exprCtx, dispatch)
    }

    await this.checkRunCompletion(runId, jobId, ancillaryFailures)

    this.logger.info('Job completed successfully', { runId, jobId })
    await this.runAncillaryOperation(runId, jobId, 'analytics.job.completed', async () => {
      await this.analytics?.track('workflow.job.completed', {
        runId, jobId, jobName: job?.jobName, durationMs: duration, stepCount: job?.steps.length ?? 0,
      })
    }, ancillaryFailures)
    await this.runAncillaryOperation(runId, jobId, 'event.publish.job.succeeded', () => this.publishEvent({
      type: EVENT_NAMES.job.succeeded,
      runId,
      jobId,
      payload: { jobName: job?.jobName, durationMs: duration },
    }), ancillaryFailures)
    for (const skippedJob of dispatch.skipped) {
      this.logger.info('Job skipped: if condition false', { runId, jobId: skippedJob.id, condition: skippedJob.if })
    }
    for (const releasedJob of dispatch.jobs) {
      await this.runAncillaryOperation(runId, releasedJob.id, 'scheduler.enqueue', () =>
        this.scheduler.enqueueJob(runId, releasedJob, releasedJob.priority ?? 'normal'), ancillaryFailures)
    }
    return { ancillaryFailures }
  }

  private async persistSuccessfulDependents(
    runId: string,
    completedJob: JobRun,
    exprCtx: ExpressionContext,
    dispatch: { jobs: JobRun[]; skipped: JobRun[] },
  ): Promise<void> {
    const released = await this.stateStore.resolveBlockedJobs(runId, completedJob.jobName, { outcome: 'success' })
    for (const releasedJob of released) {
      if (releasedJob.if && !this.evaluateJobIf(releasedJob.if, exprCtx)) {
        await this.stateStore.transitionJob(runId, releasedJob.id, 'success', (draft) => {
          const now = new Date().toISOString()
          draft.startedAt = now
          draft.finishedAt = now
        })
        dispatch.skipped.push(releasedJob)
        await this.persistSuccessfulDependents(runId, releasedJob, exprCtx, dispatch)
      } else {
        dispatch.jobs.push(releasedJob)
      }
    }
  }

  /** Build a minimal ExpressionContext from run state (for job-level if evaluation). */
  private buildExpressionContext(run: WorkflowRun | undefined | null): ExpressionContext {
    const ctx: ExpressionContext = {
      env: run?.env ?? {},
      trigger: run?.trigger ?? { type: 'manual' },
      inputs: run?.inputs ?? {},
      steps: {},
    }
    if (run) {
      for (const j of run.jobs) {
        for (const s of j.steps) {
          if (s.status === 'success' && s.spec.id) {
            ctx.steps[s.spec.id] = { outputs: (s.outputs ?? {}) as Record<string, unknown> }
          }
        }
      }
    }
    return ctx
  }

  /** Evaluate a job-level `if:` expression. Strips ${{ }} wrapper if present. */
  private evaluateJobIf(condition: string, ctx: ExpressionContext): boolean {
    const raw = condition.trim().replace(/^\$\{\{\s*/, '').replace(/\s*\}\}$/, '')
    return evaluateExpression(raw, ctx)
  }

  /**
   * Check if all jobs in a run are completed and update run status accordingly.
   */
  private async checkRunCompletion(runId: string, jobId: string, ancillaryFailures: WorkflowAncillaryFailure[] = []): Promise<void> {
    const run = await this.getRun(runId)
    if (!run) {
      return
    }

    // Check status of all jobs
    const allSuccess = run.jobs.every((j) => j.status === 'success')
    const anyFailed = run.jobs.some((j) => j.status === 'failed')
    // A job that isn't terminal yet still needs an executor to finish it —
    // including 'interrupted'/'waiting_approval'/'waiting_child' jobs, which
    // are legitimately parked and NOT the same as "done". The previous check
    // here only looked at 'running'/'queued', so a run with one job parked
    // (e.g. waiting on human approval) and another job that just failed
    // would be finalized as 'failed' out from under the parked job — the
    // exact bug class this rework closes at the run level.
    const anyNonTerminal = run.jobs.some((j) => !isTerminal(j.status, 'job') && !j.blocked)

    if (anyNonTerminal) {
      return
    }

    // Update run status based on job outcomes
    if (allSuccess) {
      const updated = await this.transitionRunTerminal(runId, 'success', (draft) => {
        draft.finishedAt = new Date().toISOString()
        draft.result = {
          ...(draft.result ?? { status: 'success' }),
          status: 'success',
          outputs: this.resolveDeclaredOutputs(draft),
        }
        return draft
      })
      this.logger.info('Workflow run completed successfully', { runId })

      if (updated) {
        await this.runAncillaryOperation(runId, jobId, 'analytics.run.completed', async () => {
          await this.analytics?.track('workflow.run.completed', {
            runId, name: run.name, jobCount: run.jobs.length, status: 'success',
          })
        }, ancillaryFailures)
        await this.runAncillaryOperation(runId, jobId, 'event.publish.run.finished', () => this.publishEvent({
          type: EVENT_NAMES.run.finished,
          runId,
          payload: { status: 'success', name: run.name },
        }), ancillaryFailures)
        await this.runAncillaryOperation(runId, jobId, 'snapshot.create', () => this.snapshotTerminalRun(updated), ancillaryFailures)
        await this.runAncillaryOperation(runId, jobId, 'workflow.child.reconcile', async () => {
          await this.reconcileChildInvocation(runId)
        }, ancillaryFailures)
      }
    } else if (anyFailed) {
      // Surface the failing job's error at the run level so consumers (REST
      // /runs/:id, Studio, e2e) can show *why* the run failed without digging
      // into per-job records.
      const failedJob = run.jobs.find((j) => j.status === 'failed')
      const updated = await this.transitionRunTerminal(runId, 'failed', (draft) => {
        draft.finishedAt = new Date().toISOString()
        if (failedJob?.error) {
          draft.result = {
            status: 'failed',
            summary: `Job ${failedJob.jobName} failed`,
            error: {
              message: failedJob.error.message,
              code: failedJob.error.code,
              hint: failedJob.error.hint,
              details: {
                ...(failedJob.error.details ?? {}),
                ...(failedJob.error.stack ? { stack: failedJob.error.stack } : {}),
              },
            },
          }
        }
        return draft
      })
      this.logger.info('Workflow run failed', { runId })

      if (updated) {
        await this.runAncillaryOperation(runId, jobId, 'analytics.run.completed', async () => {
          await this.analytics?.track('workflow.run.completed', {
            runId, name: run.name, jobCount: run.jobs.length, status: 'failed',
          })
        }, ancillaryFailures)
        await this.runAncillaryOperation(runId, jobId, 'event.publish.run.failed', () => this.publishEvent({
          type: EVENT_NAMES.run.failed,
          runId,
          payload: { status: 'failed', name: run.name },
        }), ancillaryFailures)
        await this.runAncillaryOperation(runId, jobId, 'snapshot.create', () => this.snapshotTerminalRun(updated), ancillaryFailures)
        await this.runAncillaryOperation(runId, jobId, 'workflow.child.reconcile', async () => {
          await this.reconcileChildInvocation(runId)
        }, ancillaryFailures)
      }
    }
  }

  /**
   * Mark step as started (running).
   */
  async markStepStarted(runId: string, jobId: string, stepId: string): Promise<void> {
    const step = await this.stateStore.transitionStep(runId, jobId, stepId, 'running', (draft) => {
      draft.startedAt = new Date().toISOString()
    })

    this.logger.debug('Step started', { runId, jobId, stepId })

    await this.publishEvent({
      type: EVENT_NAMES.step.started,
      runId,
      jobId,
      stepId,
    }, step?.eventSequence)
  }

  /**
   * Mark step as completed successfully with output.
   */
  async markStepCompleted(
    runId: string,
    jobId: string,
    stepId: string,
    output?: unknown,
  ): Promise<void> {
    const step = await this.stateStore.transitionStep(runId, jobId, stepId, 'success', (draft) => {
      draft.finishedAt = new Date().toISOString()
      if (output !== undefined) {
        draft.outputs = output as Record<string, unknown>
      }
    })

    this.logger.debug('Step completed', { runId, jobId, stepId })

    await this.publishEvent({
      type: EVENT_NAMES.step.succeeded,
      runId,
      jobId,
      stepId,
      payload: output !== undefined ? { outputs: output } : undefined,
    }, step?.eventSequence)
  }

  /**
   * Mark step as failed with error.
   */
  async markStepFailed(
    runId: string,
    jobId: string,
    stepId: string,
    error: Error & { code?: string; hint?: string; details?: Record<string, unknown> },
    outputs?: Record<string, unknown>,
  ): Promise<void> {
    const step = await this.stateStore.transitionStep(runId, jobId, stepId, 'failed', (draft) => {
      draft.finishedAt = new Date().toISOString()
      draft.error = {
        message: error.message,
        code: error.code,
        hint: error.hint,
        details: error.details,
        stack: error.stack,
      }
      if (outputs) {draft.outputs = outputs}
    })

    this.logger.debug('Step failed', { runId, jobId, stepId, error: error.message })

    await this.publishEvent({
      type: EVENT_NAMES.step.failed,
      runId,
      jobId,
      stepId,
      payload: { error: error.message },
    }, step?.eventSequence)
  }

  /**
   * Mark step as waiting for human approval.
   */
  /**
   * Park a step waiting for human approval — and park its parent job with
   * it, in the SAME atomic write (one `transitionJob` call touching both the
   * job's own status and its nested step). Two separate writes (step then
   * job) would leave a window where a reader could observe step=waiting but
   * job=running; going through one call closes that window entirely, not
   * just narrows it.
   *
   * The job-level `waiting_approval` status is what makes the daemon-restart
   * exemption in `cleanupStaleRuns` structural: that force-fail loop only
   * ever touches `running`/`queued` jobs, so a parked job is never in its
   * blast radius — no bespoke "is this job actually abandoned or just
   * waiting on a human" check needed there.
   */
  async markStepWaitingApproval(
    runId: string,
    jobId: string,
    stepId: string,
  ): Promise<void> {
    await this.stateStore.transitionJob(runId, jobId, 'waiting_approval', (jobDraft) => {
      const step = jobDraft.steps.find((s) => s.id === stepId)
      if (!step) {
        return
      }
      assertTransition('step', step.status, 'waiting_approval')
      step.status = 'waiting_approval'
      step.startedAt = step.startedAt ?? new Date().toISOString()
    })

    await this.publishEvent({
      type: EVENT_NAMES.step.waitingApproval,
      runId,
      payload: { jobId, stepId },
    })

    this.logger.info('Step waiting for approval', { runId, jobId, stepId })
  }

  /**
   * Park a step (and its parent job — see `markStepWaitingApproval`'s
   * docblock for why job+step move together in one write) while its child
   * workflow runs. The worker returns after this transition, so parent
   * workflows never consume the pool needed by children.
   */
  async markStepWaitingChild(
    runId: string,
    jobId: string,
    stepId: string,
    childRunId: string,
  ): Promise<void> {
    await this.stateStore.transitionJob(runId, jobId, 'waiting_child', (jobDraft) => {
      const step = jobDraft.steps.find((s) => s.id === stepId)
      if (!step) {
        return
      }
      assertTransition('step', step.status, 'waiting_child')
      step.status = 'waiting_child'
      step.startedAt ??= new Date().toISOString()
      step.metadata = { ...(step.metadata ?? {}), childRunId }
    })

    await this.publishEvent({
      type: EVENT_NAMES.step.waitingChild,
      runId,
      jobId,
      stepId,
      payload: { childRunId },
    })
  }

  /** Re-queue a parked parent job after its child workflow reaches a terminal state. */
  async resumeJob(runId: string, jobId: string): Promise<void> {
    const job = await this.stateStore.transitionJob(runId, jobId, 'queued', (draft) => {
      draft.finishedAt = undefined
    })
    if (job) {
      await this.scheduler.enqueueJob(runId, job, job.priority ?? 'normal')
    }
  }

  /**
   * Resolve a pending approval — approve or reject.
   * On approve: marks step as success with approval outputs.
   * On reject: marks step as failed with rejection error.
   *
   * Resolves the step AND un-parks the job (`waiting_approval` → `queued`)
   * in one atomic write — same reasoning as `markStepWaitingApproval` — then
   * re-enqueues the job. This re-enqueue is what actually resumes execution:
   * with approval no longer polled in-process (the worker parks and returns
   * instead of waiting), nothing else will ever pick this job back up.
   */
  async resolveApproval(
    runId: string,
    jobId: string,
    stepId: string,
    action: 'approve' | 'reject',
    data?: Record<string, unknown>,
    comment?: string,
  ): Promise<void> {
    // Guard against a stale approval: after markStepWaitingApproval parks the
    // job, `cleanupStaleRuns` never force-fails it (that's the whole point of
    // this rework) — but the run can still legitimately go terminal out from
    // under a pending approval via a plain `cancelRun` (which doesn't cascade
    // into cancelling this run's own in-flight jobs/steps). Without this
    // check, a human clicking an approval link open in a stale tab could
    // resolve a step whose run was already cancelled — resurrecting a dead
    // run's job into 'queued' and re-enqueuing it. `transitionJob` below
    // would also reject an already-terminal *job* on its own (its transition
    // table has no outgoing edges from a terminal state), but it has no way
    // to see the *run's* status — only this pre-check does.
    const run = await this.stateStore.getRun(runId)
    const existingJob = run?.jobs.find((j) => j.id === jobId)
    if (!run || !existingJob) {
      throw new Error(`Cannot resolve approval: run or job not found (runId=${runId}, jobId=${jobId})`)
    }
    if (isTerminal(run.status, 'run') || isTerminal(existingJob.status, 'job')) {
      throw new IllegalStateTransitionError('job', existingJob.status, 'queued', {
        reason: `run.status=${run.status}`,
      })
    }

    const stepStatus: StepRun['status'] = action === 'approve' ? 'success' : 'failed'
    const outputs = {
      approved: action === 'approve',
      action,
      ...(comment ? { comment } : {}),
      ...(data ?? {}),
    }

    const job = await this.stateStore.transitionJob(runId, jobId, 'queued', (jobDraft) => {
      const step = jobDraft.steps.find((s) => s.id === stepId)
      if (!step) {
        return
      }
      assertTransition('step', step.status, stepStatus)
      step.status = stepStatus
      step.finishedAt = new Date().toISOString()
      step.outputs = outputs
      if (action === 'reject') {
        step.error = { message: comment || 'Approval rejected', code: 'APPROVAL_REJECTED' }
      }
      jobDraft.finishedAt = undefined
    })

    this.logger.info(action === 'approve' ? 'Approval granted' : 'Approval rejected', { runId, jobId, stepId, comment })

    await this.publishEvent({
      type: EVENT_NAMES.step.updated,
      runId,
      payload: { jobId, stepId, action },
    })

    if (job) {
      await this.scheduler.enqueueJob(runId, job, job.priority ?? 'normal')
    }
  }

  /**
   * Get the state store for direct access (used by worker for gate restart-from).
   */
  getStateStore(): StateStore {
    return this.stateStore
  }

  /**
   * Get the scheduler for direct access (used by worker for gate re-enqueue).
   */
  getScheduler(): Scheduler {
    return this.scheduler
  }

  /**
   * Renew this instance's daemon liveness lease. Call once cleanupStaleRuns
   * has decided this instance is safe to proceed, then periodically (see
   * `DAEMON_LEASE_HEARTBEAT_INTERVAL_MS`) for as long as the daemon stays
   * up — a live daemon's lease must never lapse, since `cleanupStaleRuns`
   * treats a lapsed lease as proof its owner is genuinely gone.
   */
  async renewDaemonLease(): Promise<void> {
    await this.stateStore.writeDaemonLease(this.instanceId)
  }

  /**
   * Mark stale running/queued jobs as failed on daemon startup — their
   * executor process is gone, so they're unrecoverable. The run itself is
   * only finalized as 'failed' if nothing else could still complete it;
   * a run with one abandoned job and one job legitimately parked on a human
   * approval or a child workflow stays 'running' (only the abandoned job is
   * failed) until the parked one resolves.
   *
   * Before touching anything, this checks the shared daemon liveness lease
   * (see `StateStore.getDaemonLease`/`writeDaemonLease`). Being CALLED is not
   * by itself evidence of a restart — that's exactly what let a stray or
   * duplicate daemon process (e.g. a second launch racing a daemon that never
   * actually restarted) force-fail a genuinely in-flight run out from under
   * a still-alive sibling instance, purely because it, too, executed its own
   * one-time startup sweep against the same shared state store. A lease still
   * fresh under a DIFFERENT instanceId is real, recent (within
   * `DAEMON_LEASE_TTL_MS`) evidence that some other process is currently
   * alive and heartbeating — in that case this pass must not run at all, no
   * matter how long any individual job has been "running": elapsed job
   * runtime is never a substitute for genuine restart evidence, and is not
   * even consulted here.
   */
  async cleanupStaleRuns(): Promise<void> {
    const priorLease = await this.stateStore.getDaemonLease()
    if (priorLease && priorLease.instanceId !== this.instanceId) {
      this.logger.error(
        'cleanupStaleRuns: a daemon liveness lease held by a different instance is still fresh — ' +
          'skipping stale-run cleanup entirely to avoid abandoning runs that may genuinely still be ' +
          'in flight under that instance. If no other workflow daemon is actually running, this lease ' +
          'is simply stale past its own restart window and the next daemon start will clean up normally.',
        undefined,
        {
          thisInstanceId: this.instanceId,
          otherInstanceId: priorLease.instanceId,
          otherHeartbeatAt: priorLease.heartbeatAt,
        },
      )
      return
    }
    await this.stateStore.writeDaemonLease(this.instanceId)

    const runIds = await this.stateStore.getAllRunIds()
    const now = new Date().toISOString()
    let count = 0
    const runs = await this.listStoredRuns()
    const protectedChildRunIds = new Set(
      runs.flatMap((run) => run.jobs.flatMap((job) => job.steps
        .filter((step) => step.status === 'waiting_child')
        .map((step) => step.metadata?.['childRunId'])
        .filter((id): id is string => typeof id === 'string'))),
    )

    await Promise.all(
      runIds.map(async (runId) => {
        const run = await this.stateStore.getRun(runId)
        if (!run) { return }
        if (run.status !== 'running' && run.status !== 'queued') { return }
        // NOTE on what changed here vs. what stayed: the old code had a
        // bespoke early-return scanning this run's OWN steps for
        // `waiting_child` before ever looking at job statuses. That's gone —
        // a job whose step is waiting_approval/waiting_child now carries
        // that status itself (see markStepWaitingApproval/markStepWaitingChild),
        // so the force-fail loop below already skips it structurally, just by
        // virtue of not being 'running'/'queued'. No special-cased `if` needed.
        //
        // `protectedChildRunIds` below is a DIFFERENT, still-needed concern:
        // it protects a CHILD run's OWN in-flight jobs (not the parent's
        // parked step) — if this run IS someone's child and its jobs were
        // running when the daemon died, they're durable orchestration state
        // too and get a resumable 'interrupted' instead of a hard 'failed'.
        if (protectedChildRunIds.has(run.id)) {
          const hasRunningJob = run.jobs.some((job) => job.status === 'running')
          if (hasRunningJob) {
            await this.stateStore.updateRun(runId, (draft) => {
              for (const job of draft.jobs) {
                if (job.status === 'running') {
                  job.status = 'interrupted'
                  job.finishedAt = now
                  for (const step of job.steps) {
                    if (step.status === 'running') {
                      step.status = 'queued'
                      step.startedAt = undefined
                      step.finishedAt = undefined
                    }
                  }
                }
              }
            })
          }
          return
        }

        // A job legitimately parked (waiting_approval/waiting_child) keeps
        // the run alive even if some OTHER job in the same run really was
        // abandoned by the crashed daemon — finalizing the whole run here
        // would recreate this rework's original bug shape (run=failed while
        // a step is still waiting_approval), just one level up. Only the
        // genuinely abandoned jobs get failed; the run itself is only
        // finalized if nothing is left that could still bring it home.
        const hasParkedJob = run.jobs.some((job) => job.status === 'waiting_approval' || job.status === 'waiting_child')
        const abandonedJobIds = run.jobs
          .filter((job) => job.status === 'running' || job.status === 'queued')
          .map((job) => job.id)

        if (abandonedJobIds.length === 0) {
          return
        }

        if (hasParkedJob) {
          await this.failAbandonedJobs(runId, abandonedJobIds, now)
          count++
          await this.checkRunCompletion(runId, abandonedJobIds[0]!)
          return
        }

        await this.failAbandonedJobs(runId, abandonedJobIds, now)
        count++
        await this.checkRunCompletion(runId, abandonedJobIds[0]!)
      }),
    )

    if (count > 0) {
      this.logger.warn('Cleaned up stale runs from previous daemon process', { count })
    }
  }

  private async failAbandonedJobs(runId: string, jobIds: string[], finishedAt: string): Promise<void> {
    const run = await this.stateStore.getRun(runId)
    if (!run) { return }

    for (const jobId of jobIds) {
      const job = run.jobs.find((candidate) => candidate.id === jobId)
      if (!job) { continue }
      const message = 'Daemon restarted — run was abandoned'
      for (const step of job.steps) {
        if (step.status === 'running') {
          await this.stateStore.transitionStep(runId, jobId, step.id, 'failed', (draft) => {
            draft.error = { message }
            draft.finishedAt = finishedAt
          })
        }
      }
      await this.stateStore.transitionJob(runId, jobId, 'failed', (draft) => {
        draft.error = { message }
        draft.finishedAt = finishedAt
      })
    }
  }

  /**
   * Resume interrupted jobs on daemon startup.
   * Re-queues jobs that were interrupted during previous shutdown.
   */
  async resumeInterruptedJobs(): Promise<void> {
    const runIds = await this.stateStore.getAllRunIds()

    // Process all runs in parallel
    const results = await Promise.all(
      runIds.map(async runId => {
        const run = await this.stateStore.getRun(runId)
        if (!run) {return 0}

        const interruptedJobs = run.jobs.filter(job => job.status === 'interrupted')

        // Process all interrupted jobs in this run in parallel
        await Promise.all(
          interruptedJobs.map(async job => {
            this.logger.info('Resuming interrupted job', { runId, jobId: job.id })

            await this.stateStore.transitionJob(runId, job.id, 'queued', (draft) => {
              draft.startedAt = undefined
              draft.finishedAt = undefined
            })

            // Re-enqueue in scheduler
            const queuedJob = { ...job, status: 'queued' as const }
            await this.scheduler.enqueueJob(runId, queuedJob, queuedJob.priority ?? 'normal')
          }),
        )

        return interruptedJobs.length
      }),
    )

    const resumedCount = results.reduce((sum, count) => sum + count, 0)

    if (resumedCount > 0) {
      this.logger.info('Resumed interrupted jobs', { count: resumedCount })
    }
  }

  /**
   * Move permanently failed job to Dead Letter Queue.
   */
  /**
   * Record a dead-letter entry for a job that exhausted its retries. This is an
   * observability artifact only — it does NOT change the run status. The run
   * outcome is decided by checkRunCompletion (→ 'failed'). 'dlq' as a run status
   * is reserved for infrastructure failures and is no longer set here (B-029).
   */
  private async deadLetterJob(runId: string, jobId: string, error: Error): Promise<void> {
    this.logger.warn('Job dead-lettered after max retries', { runId, jobId })

    const dlqKey = workflowDeadLetterCacheKey(runId, jobId)
    const run = await this.stateStore.getRun(runId)
    const job = run?.jobs.find((j) => j.id === jobId)

    await this.options.cache.set(
      dlqKey,
      JSON.stringify({
        runId,
        jobId,
        jobName: job?.jobName,
        error: {
          message: error.message,
          stack: error.stack,
        },
        timestamp: new Date().toISOString(),
        attempts: job?.attempt || 0,
      }),
      7 * 24 * 60 * 60 * 1000 // TTL 7 days
    )
  }

  async updateRun(
    runId: string,
    mutator: (run: WorkflowRun) => WorkflowRun | void,
  ): Promise<WorkflowRun | null> {
    const updated = await this.stateStore.updateRun(runId, mutator)
    if (updated) {
      await this.publishRunEvent(EVENT_NAMES.run.updated, updated)
    }
    return updated
  }

  async finalizeRun(
    runId: string,
    status: TerminalRunState,
    context: Partial<RunContext> = {},
  ): Promise<{ run: WorkflowRun | null; ancillaryFailures: WorkflowAncillaryFailure[] }> {
    const ancillaryFailures: WorkflowAncillaryFailure[] = []
    const updated = await this.transitionRunTerminal(runId, status, (run) => {
      const now = new Date().toISOString()
      run.finishedAt = now
      run.durationMs = computeDurationMs(run.startedAt ?? run.queuedAt, now)
      if (context.jobs) {
        run.jobs = context.jobs
      }
      if (context.steps) {
        // optional override steps already included in jobs
      }
      return run
    })

    if (updated) {
      await this.runAncillaryOperation(runId, '', 'concurrency.release', () => this.runCoordinator.releaseConcurrency(updated), ancillaryFailures)
      await this.runAncillaryOperation(runId, '', 'event.publish.run.finalized', () => this.publishRunEvent(
        status === 'failed' ? EVENT_NAMES.run.failed : status === 'cancelled' ? EVENT_NAMES.run.cancelled : EVENT_NAMES.run.finished,
        updated,
      ), ancillaryFailures)
      await this.runAncillaryOperation(runId, '', 'snapshot.create', () => this.snapshotTerminalRun(updated), ancillaryFailures)
    }

    return { run: updated, ancillaryFailures }
  }

  /**
   * Persist a snapshot for a run that just reached a terminal state, so it
   * can be replayed from any step later (`replayRun`, used by both
   * `workflow runs restart --from-step` and `rerun --failed-only`). Only
   * 'success'/'failed' carry meaningful step output data worth snapshotting.
   *
   * Shared by finalizeRun() and checkRunCompletion() — checkRunCompletion is
   * the run-completion path actually driven by the worker in production, so
   * without this call here, no snapshot is ever created outside of tests
   * that call finalizeRun() directly (issue #263).
   */
  private async snapshotTerminalRun(run: WorkflowRun): Promise<void> {
    if (run.status !== 'success' && run.status !== 'failed') {
      return
    }

    const stepOutputs: Record<string, Record<string, unknown>> = {}
    for (const job of run.jobs) {
      for (const step of job.steps) {
        if (step.outputs && Object.keys(step.outputs).length > 0) {
          stepOutputs[step.id] = step.outputs
        }
      }
    }

    await this.snapshotStorage.createSnapshot(run, stepOutputs, run.env ?? {})
  }

  async nextJob(): Promise<JobQueueEntry | null> {
    return this.scheduler.dequeueJob()
  }

  async rescheduleJob(entry: JobQueueEntry, delayMs: number): Promise<void> {
    await this.scheduler.reschedule(entry, delayMs)
  }

  async publishRunEvent(
    type: WorkflowEventName,
    run: WorkflowRun,
  ): Promise<void> {
    await this.publishEvent({
      type,
      runId: run.id,
      payload: {
        status: run.status,
        name: run.name,
        version: run.version,
      },
    })
  }

  /**
   * Publish a log entry for real-time streaming to Studio UI.
   */
  async publishLog(
    runId: string,
    jobId: string,
    stepId: string,
    entry: { level: string; message: string; stream: string; lineNo: number; timestamp: string; meta?: Record<string, unknown> },
    stepName?: string,
  ): Promise<void> {
    await this.publishEvent({
      type: EVENT_NAMES.log.appended,
      runId,
      jobId,
      stepId,
      payload: stepName ? { ...entry, stepName } : entry,
    })
  }

  /**
   * Create a snapshot of the current run state
   */
  async createSnapshot(
    runId: string,
    stepOutputs: Record<string, Record<string, unknown>>,
    env: Record<string, string>,
    refs?: RunSnapshot['refs'],
  ): Promise<RunSnapshot | null> {
    const run = await this.getRun(runId)
    if (!run) {
      this.logger.warn('Cannot create snapshot: run not found', { runId })
      return null
    }

    return this.snapshotStorage.createSnapshot(run, stepOutputs, env, refs)
  }

  /**
   * Get a snapshot for a run
   */
  async getSnapshot(runId: string): Promise<RunSnapshot | null> {
    return this.snapshotStorage.getSnapshot(runId)
  }

  /**
   * Replay a run from a snapshot, optionally starting from a specific step
   */
  // eslint-disable-next-line sonarjs/cognitive-complexity -- Replay orchestration: handles snapshot loading, step state transitions (before/at/after fromStep), env merging, job traversal, and conditional status reset logic
  async replayRun(
    runId: string,
    options: {
      fromStepId?: string
      stepOutputs?: Record<string, Record<string, unknown>>
      env?: Record<string, string>
    } = {},
  ): Promise<WorkflowRun | null> {
    // Load snapshot
    const snapshot = await this.snapshotStorage.getSnapshot(runId)
    if (!snapshot) {
      this.logger.warn('Cannot replay: snapshot not found', { runId })
      return null
    }

    if (snapshot.refs?.workspaceSnapshotId || snapshot.refs?.environmentSnapshotId) {
      if (!this.options.snapshotManager) {
        throw new Error('SnapshotManager is required for replay with infra snapshot references')
      }

      if (snapshot.refs.workspaceSnapshotId) {
        await this.options.snapshotManager.restoreSnapshot({
          snapshotId: snapshot.refs.workspaceSnapshotId,
          metadata: { source: 'workflow.replay', runId },
        })
      }

      if (snapshot.refs.environmentSnapshotId) {
        await this.options.snapshotManager.restoreSnapshot({
          snapshotId: snapshot.refs.environmentSnapshotId,
          metadata: { source: 'workflow.replay', runId },
        })
      }
    }

    // Restore run state
    const restoredRun = snapshot.run
    requireWorkflowId(restoredRun)

    // Restore env if provided
    if (options.env) {
      restoredRun.env = { ...snapshot.env, ...options.env }
    } else {
      restoredRun.env = snapshot.env
    }

    // Validate fromStepId before any state mutation — a non-existent ID must be
    // a hard error (404), not a silent success that saves a broken run state.
    if (options.fromStepId) {
      const stepExists = restoredRun.jobs.some(job =>
        job.steps.some(s => s.id === options.fromStepId),
      )
      if (!stepExists) {
        throw new Error(`Step not found: ${options.fromStepId}`)
      }
    }

    // If fromStepId is specified, mark all steps before it as completed.
    // foundStep is declared outside the job loop so jobs after the job
    // containing fromStepId have all their steps correctly reset to queued.
    if (options.fromStepId) {
      let foundStep = false
      const restartJob = restoredRun.jobs.find((job) =>
        job.steps.some((step) => step.id === options.fromStepId),
      )
      for (const job of restoredRun.jobs) {
        if (job.status === 'success' && job !== restartJob) {
          continue
        }
        for (const step of job.steps) {
          if (step.id === options.fromStepId) {
            foundStep = true
            step.status = 'queued'
            step.startedAt = undefined
            step.finishedAt = undefined
            continue
          }
          if (!foundStep) {
            // Mark previous steps as completed
            if (step.status === 'running' || step.status === 'queued') {
              step.status = 'success'
              step.finishedAt = step.finishedAt ?? new Date().toISOString()
            }
          } else {
            // Reset steps after the target step
            step.status = 'queued'
            step.startedAt = undefined
            step.finishedAt = undefined
          }
        }
      }
    } else {
      // Reset all steps to queued
      for (const job of restoredRun.jobs) {
        for (const step of job.steps) {
          step.status = 'queued'
          step.startedAt = undefined
          step.finishedAt = undefined
        }
      }
    }

    // Create a new run identity before rebuilding its nested job and step IDs.
    const newRunId = randomUUID()
    const newNow = new Date().toISOString()

    // A replay is a new run with new identities. Keep completed work before a
    // restart point, and make every job with queued work executable again.
    const replayJobs = restoredRun.jobs.map((job) => {
      const jobId = `${newRunId}:${job.jobName}`
      const steps = job.steps.map((step) => {
        const completed = step.status === 'success' || step.status === 'skipped'
        return {
          ...step,
          id: `${jobId}:${step.index}`,
          runId: newRunId,
          jobId,
          queuedAt: completed ? step.queuedAt : newNow,
          startedAt: completed ? step.startedAt : undefined,
          finishedAt: completed ? step.finishedAt : undefined,
          durationMs: completed ? step.durationMs : undefined,
          attempt: 0,
          outputs: completed ? step.outputs : undefined,
          error: completed ? step.error : undefined,
        }
      })
      const completed = steps.every((step) => step.status === 'success' || step.status === 'skipped')
      return {
        ...job,
        id: jobId,
        runId: newRunId,
        status: completed ? 'success' as const : 'queued' as const,
        queuedAt: newNow,
        startedAt: completed ? job.startedAt : undefined,
        finishedAt: completed ? job.finishedAt : undefined,
        durationMs: completed ? job.durationMs : undefined,
        attempt: 0,
        error: completed ? job.error : undefined,
        steps,
      }
    })

    // Reconstruct job.blocked and job.pendingDependencies based on the reset
    // step state. In a completed run all jobs have blocked=false, so without
    // this step scheduleRun would enqueue all jobs simultaneously, ignoring
    // declared dependency ordering (needs: [...]).
    const isJobComplete = (job: JobRun): boolean =>
      job.steps.every(s => s.status === 'success' || s.status === 'skipped')

    for (const job of replayJobs) {
      if (!job.needs || job.needs.length === 0) {
        job.blocked = false
        job.pendingDependencies = []
        continue
      }
      const pendingDeps = job.needs.filter(depName => {
        const depJob = restoredRun.jobs.find(j => j.jobName === depName)
        return depJob !== undefined && !isJobComplete(depJob)
      })
      job.pendingDependencies = pendingDeps
      job.blocked = pendingDeps.length > 0
    }

    // Create a new run ID so the original run's history is preserved.
    // Overwriting the same ID would destroy history and corrupt state if the
    // original run's worker is still live (race condition).
    const newRun: WorkflowRun = {
      ...restoredRun,
      id: newRunId,
      jobs: replayJobs,
      status: 'queued',
      createdAt: newNow,
      queuedAt: newNow,
      startedAt: undefined,
      finishedAt: undefined,
      durationMs: undefined,
      result: undefined,
    }

    // Save the new run (original run at its own ID is untouched)
    await this.stateStore.saveRun(newRun)

    // Schedule the new run
    await this.scheduler.scheduleRun(newRun)

    this.logger.info('Run replayed as new run from snapshot', {
      originalRunId: runId,
      newRunId,
      fromStepId: options.fromStepId,
    })

    return newRun
  }

  /**
   * Delete a snapshot
   */
  async deleteSnapshot(runId: string): Promise<void> {
    await this.snapshotStorage.deleteSnapshot(runId)
  }

  /**
   * Get all active workflow executions (running or queued).
   * Returns array of WorkflowRun objects with status 'running' or 'queued'.
   */
  async getActiveExecutions(): Promise<WorkflowRun[]> {
    // Get all run IDs from sorted set index
    const runIds = await this.stateStore.getAllRunIds()

    // Fetch all runs in parallel and filter for active ones
    const runs = await Promise.all(runIds.map(id => this.stateStore.getRun(id)))

    return runs.filter(
      (run): run is WorkflowRun =>
        run !== null && (run.status === 'running' || run.status === 'queued'),
    )
  }

  /**
   * Get all workflow runs (all statuses).
   * Returns array of all WorkflowRun objects ordered by creation time.
   */
  async getAllRuns(): Promise<WorkflowRun[]> {
    // Get all run IDs from sorted set index
    const runIds = await this.stateStore.getAllRunIds()

    // Fetch all runs in parallel and filter out nulls
    const runs = await Promise.all(runIds.map(id => this.stateStore.getRun(id)))

    return runs.filter((run): run is WorkflowRun => run !== null)
  }

  /**
   * List all workflow runs.
   * Returns array of all runs in the system.
   * Alias for getAllRuns() - maintained for backward compatibility.
   */
  async listRuns(): Promise<WorkflowRun[]> {
    return this.getAllRuns()
  }

  /**
   * Get workflow engine metrics.
   * Returns statistics about runs, jobs, and system health.
   */
  // eslint-disable-next-line sonarjs/cognitive-complexity -- Metrics aggregation: iterates all runs and jobs, counts by status (6 run statuses + 4 job statuses), handles nulls
  async getMetrics(): Promise<{
    runs: {
      total: number
      queued: number
      running: number
      success: number
      failed: number
      cancelled: number
      dlq: number
    }
    jobs: {
      total: number
      queued: number
      running: number
      success: number
      failed: number
    }
  }> {
    // Get all run IDs
    const runIds = await this.stateStore.getAllRunIds()

    const metrics = {
      runs: {
        total: 0,
        queued: 0,
        running: 0,
        success: 0,
        failed: 0,
        cancelled: 0,
        dlq: 0,
      },
      jobs: {
        total: 0,
        queued: 0,
        running: 0,
        success: 0,
        failed: 0,
      },
    }

    // Fetch all runs in parallel
    const runs = await Promise.all(runIds.map(id => this.stateStore.getRun(id)))

    // Aggregate metrics from all runs
    for (const run of runs) {
      if (!run) {continue}

      metrics.runs.total++

      // Count run status
      if (run.status === 'queued') {metrics.runs.queued++}
      else if (run.status === 'running') {metrics.runs.running++}
      else if (run.status === 'success') {metrics.runs.success++}
      else if (run.status === 'failed') {metrics.runs.failed++}
      else if (run.status === 'cancelled') {metrics.runs.cancelled++}
      else if (run.status === 'dlq') {metrics.runs.dlq++}

      // Count job statuses
      for (const job of run.jobs) {
        metrics.jobs.total++
        if (job.status === 'queued') {metrics.jobs.queued++}
        else if (job.status === 'running') {metrics.jobs.running++}
        else if (job.status === 'success') {metrics.jobs.success++}
        else if (job.status === 'failed') {metrics.jobs.failed++}
      }
    }

    return metrics
  }
}

function computeDurationMs(
  startedAt: string | undefined,
  finishedAt: string,
): number | undefined {
  if (!startedAt) {
    return undefined
  }
  const start = Date.parse(startedAt)
  const end = Date.parse(finishedAt)
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return undefined
  }
  return Math.max(0, end - start)
}
