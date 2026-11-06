/**
 * @module @kb-labs/workflow-daemon/cron-scheduler
 * CronScheduler - manages periodic job execution using node-cron
 */

import * as cron from 'node-cron';
import { CronExpressionParser } from 'cron-parser';
import type { ILogger, IAnalytics } from '@kb-labs/core-platform';
import type { JobBroker } from './job-broker.js';
import type { WorkflowEngine } from '@kb-labs/workflow-engine';
import { MissingWorkflowIdError } from '@kb-labs/workflow-contracts';
import type {
  RegisteredCronJob,
  PluginCronJob,
  UserCron,
  WorkflowSpec,
} from '@kb-labs/workflow-contracts';

export interface CronSchedulerOptions {
  jobBroker: JobBroker;
  workflowEngine: WorkflowEngine;
  logger: ILogger;
  timezone?: string;
  /** Platform analytics adapter (OPTIONAL) */
  analytics?: IAnalytics;
}

/**
 * CronScheduler manages periodic job execution.
 *
 * Features:
 * - Registers cron jobs from plugin manifests and user YAML files
 * - Uses node-cron for scheduling
 * - Submits jobs via JobBroker
 * - Graceful shutdown (stops all scheduled tasks)
 */
export class CronScheduler {
  private readonly jobBroker: JobBroker;
  private readonly workflowEngine: WorkflowEngine;
  private readonly logger: ILogger;
  private readonly defaultTimezone: string;
  private readonly analytics?: import('@kb-labs/core-platform').IAnalytics; // eslint-disable-line @typescript-eslint/consistent-type-imports

  private readonly registeredJobs = new Map<string, RegisteredCronJob>();
  private readonly scheduledTasks = new Map<string, cron.ScheduledTask>();
  private isRunning = false;

  constructor(options: CronSchedulerOptions) {
    this.jobBroker = options.jobBroker;
    this.workflowEngine = options.workflowEngine;
    this.logger = options.logger;
    this.defaultTimezone = options.timezone ?? 'UTC';
    this.analytics = options.analytics;
  }

  /**
   * Register cron job from plugin manifest.
   */
  registerPluginJob(pluginId: string, job: PluginCronJob): void {
    const cronJobId = `plugin:${pluginId}:${job.id}`;

    if (this.registeredJobs.has(cronJobId)) {
      this.logger.warn('Cron job already registered, skipping', { cronJobId });
      return;
    }

    const registered: RegisteredCronJob = {
      id: cronJobId,
      source: 'plugin',
      schedule: job.schedule,
      timezone: job.timezone ?? this.defaultTimezone,
      priority: job.priority,
      enabled: job.enabled,
      handler: job.handler,
      input: job.input,
      metadata: job.metadata,
    };

    this.registeredJobs.set(cronJobId, registered);
    this.logger.debug('Plugin cron job registered', {
      cronJobId,
      schedule: job.schedule,
      handler: job.handler,
    });
  }

  /**
   * Register cron job from user YAML file.
   */
  registerUserCron(job: UserCron, spec?: WorkflowSpec): void {
    const cronJobId = job.id;
    const registered: RegisteredCronJob = {
      id: cronJobId,
      source: 'user',
      schedule: job.schedule,
      timezone: job.timezone ?? this.defaultTimezone,
      priority: 'normal',
      enabled: job.enabled,
      ...(job.handler
        ? { handler: job.handler, input: job.input }
        : {
            workflowId: job.workflow,
            workflowInput: job.input,
            ...(spec ? { workflowSpec: {
              name: spec.name,
              version: spec.version,
              on: { manual: true as const },
              jobs: spec.jobs,
              env: spec.env,
            } } : {}),
          }),
    };

    this.register(registered);
    this.logger.debug('User cron job registered', {
      cronJobId,
      schedule: job.schedule,
      ...(job.workflow ? { workflowId: job.workflow } : { handler: job.handler }),
    });
  }

  /**
   * Start all registered cron jobs.
   * Schedules enabled jobs using node-cron.
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('CronScheduler already running');
      return;
    }

    this.logger.info('Starting CronScheduler', {
      totalJobs: this.registeredJobs.size,
    });

    for (const [cronJobId, job] of this.registeredJobs) {
      if (!job.enabled) {
        this.logger.debug('Skipping disabled cron job', { cronJobId });
        continue;
      }

      // Validate cron expression
      if (!cron.validate(job.schedule)) {
        this.logger.error('Invalid cron expression', undefined, {
          cronJobId,
          schedule: job.schedule,
        });
        continue;
      }

      // Schedule task
      const task = cron.schedule(
        job.schedule,
        () => this.executeCronJob(cronJobId, job),
        {
          timezone: job.timezone,
        }
      );

      this.scheduledTasks.set(cronJobId, task);

      this.logger.info('Cron job scheduled', {
        cronJobId,
        schedule: job.schedule,
        timezone: job.timezone,
        source: job.source,
      });
    }

    this.isRunning = true;
    this.logger.info('CronScheduler started', {
      scheduledJobs: this.scheduledTasks.size,
    });

    // Track scheduler start
    this.analytics?.track('workflow.cron.scheduler.started', {
      totalJobs: this.registeredJobs.size,
      scheduledJobs: this.scheduledTasks.size,
    }).catch(() => {});
  }

  /**
   * Stop all scheduled cron jobs.
   * Called during graceful shutdown.
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.logger.info('Stopping CronScheduler', {
      scheduledJobs: this.scheduledTasks.size,
    });

    for (const [cronJobId, task] of this.scheduledTasks) {
      task.stop();
      this.logger.debug('Cron job stopped', { cronJobId });
    }

    const stoppedCount = this.scheduledTasks.size;
    this.scheduledTasks.clear();
    this.isRunning = false;

    this.logger.info('CronScheduler stopped');

    // Track scheduler stop
    this.analytics?.track('workflow.cron.scheduler.stopped', {
      stoppedJobs: stoppedCount,
    }).catch(() => {});
  }

  /**
   * Execute cron job by submitting it to JobBroker.
   */
  private async executeCronJob(
    cronJobId: string,
    job: RegisteredCronJob
  ): Promise<void> {
    const startTime = Date.now();
    this.logger.info('Executing cron job', { cronJobId });

    // Track cron job start
    this.analytics?.track('workflow.cron.job.started', {
      cronJobId,
      source: job.source,
      schedule: job.schedule,
    }).catch(() => {});

    try {
      let runId: string;
      let runStatus = 'queued';
      if (job.handler) {
        // Handler cron job (plugin manifest or project cron) - submit via JobBroker
        const result = await this.jobBroker.submit({
          handler: job.handler,
          input: job.input,
          priority: job.priority,
          metadata: {
            ...job.metadata,
            ...(job.source === 'plugin' ? { cronJobId } : { cronId: cronJobId }),
            scheduledBy: 'cron',
            scheduledAt: new Date().toISOString(),
          },
        });
        runId = result.id;

        this.logger.info('Cron job submitted', {
          cronJobId,
          runId: result.id,
        });
      } else if (job.source === 'user' && job.workflowSpec) {
        // User cron job - run workflow directly via WorkflowEngine
        // Create complete WorkflowSpec from user job
        const spec = job.workflowSpec;
        const workflowId = job.workflowId;
        if (!workflowId) { throw new MissingWorkflowIdError(job.id); }

        this.logger.debug('Running workflow from cron', {
          cronJobId,
          spec: JSON.stringify(spec, null, 2),
        });

        const result = await this.workflowEngine.runFromInline(spec, {
          trigger: {
            type: 'schedule',
            payload: {
              cronJobId,
              scheduledAt: new Date().toISOString(),
            },
          },
          inputs: job.workflowInput ?? {},
          env: job.workflowSpec.env ?? {},
          metadata: {
            workflowId,
            cronId: cronJobId,
            scheduledBy: 'cron',
            scheduledAt: new Date().toISOString(),
          },
        });
        runId = result.id;
        runStatus = result.status;

        this.logger.info('Cron workflow submitted', {
          cronJobId,
          runId: result.id,
          workflowName: spec.name,
        });
      } else {
        throw new Error(`Invalid cron job configuration: ${cronJobId}`);
      }
      job.lastRun = { id: runId, status: runStatus, time: new Date().toISOString() };

      // Submission does not imply the workflow has reached a terminal state.
      this.analytics?.track('workflow.cron.job.submitted', {
        cronJobId,
        runId,
        source: job.source,
      }).catch((error) => this.logger.warn('Failed to record cron submission analytics', {
        cronJobId,
        runId,
        errorMessage: error instanceof Error ? error.message : String(error),
      }));
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error(
        'Failed to execute cron job',
        error instanceof Error ? error : undefined,
        { cronJobId }
      );

      // Track cron job failure
      this.analytics?.track('workflow.cron.job.failed', {
        cronJobId,
        source: job.source,
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
        durationMs: duration,
      }).catch(() => {});
    }
  }

  /**
   * Get all registered cron jobs.
   */
  getRegisteredJobs(): RegisteredCronJob[] {
    return Array.from(this.registeredJobs.values());
  }

  /**
   * Get cron job by ID.
   */
  getJob(cronJobId: string): RegisteredCronJob | undefined {
    return this.registeredJobs.get(cronJobId);
  }

  /**
   * Check if scheduler is running.
   */
  isSchedulerRunning(): boolean {
    return this.isRunning;
  }

  /**
   * Register cron job (generic method for API usage).
   * Supports both plugin and API-registered jobs.
   */
  register(job: RegisteredCronJob): void {
    if (this.registeredJobs.has(job.id)) {
      this.logger.warn('Cron job already registered, overwriting', { cronJobId: job.id });
    }

    this.registeredJobs.set(job.id, job);
    this.logger.debug('Cron job registered', {
      cronJobId: job.id,
      schedule: job.schedule,
      source: job.source,
    });

    // If scheduler is already running, schedule this job immediately
    if (this.isRunning && job.enabled) {
      this.scheduleJob(job.id, job);
    }
  }

  /**
   * Unregister cron job by ID.
   * Stops the scheduled task if running.
   */
  unregister(cronJobId: string): void {
    const job = this.registeredJobs.get(cronJobId);
    if (!job) {
      this.logger.warn('Cron job not found for unregister', { cronJobId });
      return;
    }

    // Stop scheduled task if exists
    const task = this.scheduledTasks.get(cronJobId);
    if (task) {
      task.stop();
      this.scheduledTasks.delete(cronJobId);
      this.logger.debug('Cron task stopped', { cronJobId });
    }

    // Remove from registered jobs
    this.registeredJobs.delete(cronJobId);
    this.logger.info('Cron job unregistered', { cronJobId });
  }

  /**
   * Pause cron job (stop task but keep registration).
   */
  pause(cronJobId: string): void {
    const job = this.registeredJobs.get(cronJobId);
    if (!job) {
      throw new Error(`Cron job not found: ${cronJobId}`);
    }

    const task = this.scheduledTasks.get(cronJobId);
    if (!task) {
      throw new Error(`Cron task not scheduled: ${cronJobId}`);
    }

    task.stop();
    job.enabled = false;
    this.logger.info('Cron job paused', { cronJobId });
  }

  /**
   * Resume cron job (restart stopped task).
   */
  resume(cronJobId: string): void {
    const job = this.registeredJobs.get(cronJobId);
    if (!job) {
      throw new Error(`Cron job not found: ${cronJobId}`);
    }

    const task = this.scheduledTasks.get(cronJobId);
    if (!task) {
      // Job exists but not scheduled - schedule it now
      if (this.isRunning) {
        this.scheduleJob(cronJobId, job);
      }
    } else {
      // Task exists but stopped - restart it
      task.start();
    }

    job.enabled = true;
    this.logger.info('Cron job resumed', { cronJobId });
  }

  /**
   * Trigger cron job immediately (manual execution).
   */
  async triggerNow(cronJobId: string): Promise<void> {
    const job = this.registeredJobs.get(cronJobId);
    if (!job) {
      throw new Error(`Cron job not found: ${cronJobId}`);
    }

    this.logger.info('Manually triggering cron job', { cronJobId });
    await this.executeCronJob(cronJobId, job);
  }

  /**
   * Schedule a single cron job (helper method).
   */
  private scheduleJob(cronJobId: string, job: RegisteredCronJob): void {
    // Validate cron expression
    if (!cron.validate(job.schedule)) {
      this.logger.error('Invalid cron expression', undefined, {
        cronJobId,
        schedule: job.schedule,
      });
      return;
    }

    // Schedule task
    const task = cron.schedule(
      job.schedule,
      () => this.executeCronJob(cronJobId, job),
      {
        timezone: job.timezone,
      }
    );

    this.scheduledTasks.set(cronJobId, task);

    this.logger.info('Cron job scheduled', {
      cronJobId,
      schedule: job.schedule,
      timezone: job.timezone,
      source: job.source,
    });
  }

  /**
   * Get next scheduled run time for a cron job.
   * Returns null if job doesn't exist or has invalid cron expression.
   */
  getNextRunTime(cronJobId: string): Date | null {
    const job = this.registeredJobs.get(cronJobId);
    if (!job) {
      return null;
    }

    // Return null for empty schedule
    if (!job.schedule || job.schedule.trim() === '') {
      return null;
    }

    try {
      // Parse cron expression to get next execution time
      const interval = CronExpressionParser.parse(job.schedule, {
        tz: job.timezone,
        currentDate: new Date(),
      });
      return interval.next().toDate();
    } catch (error) {
      this.logger.error('Failed to parse cron expression', error instanceof Error ? error : undefined, {
        cronJobId,
        schedule: job.schedule,
      });
      return null;
    }
  }

  /**
   * Clear all registered cron jobs.
   * IMPORTANT: This does NOT stop scheduled tasks - call stop() first if needed.
   */
  clearAll(): void {
    this.logger.info('Clearing all registered cron jobs', {
      count: this.registeredJobs.size,
    });

    this.registeredJobs.clear();
    // Note: scheduledTasks are cleared in stop()
  }

  /**
   * Unregister all user-sourced cron jobs (source === 'user'), stopping their
   * scheduled tasks. Safe to call while the scheduler is running — jobs are
   * stopped and removed so they can be re-registered by a fresh discovery pass.
   */
  clearUserJobs(): void {
    const userJobIds = Array.from(this.registeredJobs.values()).filter((job) => job.source === 'user').map((job) => job.id);

    for (const cronJobId of userJobIds) {
      const task = this.scheduledTasks.get(cronJobId);
      if (task) {
        task.stop();
        this.scheduledTasks.delete(cronJobId);
      }
      this.registeredJobs.delete(cronJobId);
    }

    this.logger.info('Cleared user cron jobs', { count: userJobIds.length });
  }
}
