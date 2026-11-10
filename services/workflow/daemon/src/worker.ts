/**
 * @module @kb-labs/workflow-daemon/worker
 * WorkflowWorker implementation - processes jobs from WorkflowEngine.
 *
 * The worker orchestrates job/step execution but delegates all code execution
 * to the execution plane (backend.execute). It knows nothing about containers,
 * environments, or workspace provisioning — that's the platform's responsibility.
 */

import type { WorkflowEngine } from "@kb-labs/workflow-engine";
import type { WorkflowService } from "@kb-labs/workflow-engine";
import { createMissingSecretError } from "@kb-labs/workflow-engine";
import type { SecretProvider } from "@kb-labs/workflow-engine";
import type { IEntityRegistry } from '@kb-labs/plugin-contracts';
import { logDiagnosticEvent } from "@kb-labs/core-platform";
import { isTerminal } from "@kb-labs/workflow-constants";
import { getJobSecretNames, getStepSecretNames, requireWorkflowId } from "@kb-labs/workflow-contracts";
import type {
  ILogger,
  IAnalytics,
  IWorkspaceProvider,
} from "@kb-labs/core-platform";
import type {
  ExecutionTarget,
  ExpressionContext,
  StepSpec,
  WorkflowRun,
  JobRun,
  StepRun,
} from "@kb-labs/workflow-contracts";
import type { ExecutionBackend } from "@kb-labs/plugin-execution";
import { createContextLogger, registerProcessSensitiveValues } from "@kb-labs/core-platform";
import {
  buildShellSafeCommand,
  interpolateObject,
  interpolateString,
  evaluateExpression,
  coerceToString,
} from "@kb-labs/workflow-contracts";
import type { GateInput } from "@kb-labs/workflow-steps";
import { GateHandler, type GateDecision } from "@kb-labs/workflow-steps";
import {
  projectStepEnvironment,
  SandboxRunner,
  summarizeWorkflowInput,
} from "@kb-labs/workflow-runtime";

interface StepSpecRaw {
  name: string;
  run?: string;
  uses?: string;
  summary?: string;
  with?: Record<string, unknown>;
  [key: string]: unknown;
}

interface Platform {
  readonly executionBackend: ExecutionBackend;
  readonly hasExecutionBackend: boolean;
  getAdapter<T = unknown>(name: string): T | undefined;
}

export interface CreateWorkflowWorkerOptions {
  engine: WorkflowEngine;
  secretProvider: SecretProvider;
  /** Resolves workspace child workflows for `uses: workflow:workspace:<id>`. */
  workflowService?: WorkflowService;
  cliApi: IEntityRegistry;
  logger: ILogger;
  platform: Platform;
  workspaceRoot: string;
  platformRoot?: string;
  projectRoot?: string;
  projectId: string;
  concurrency?: number;
  /** Default timeout for step execution (ms). Default: 120000 (2 minutes) */
  defaultTimeout?: number;
  /** Platform analytics adapter (OPTIONAL) */
  analytics?: IAnalytics;
  /**
   * Enable verbose debug logging (inputs, expr context, interpolation details).
   * Defaults to WORKFLOW_DEBUG env var. Pass true to force-enable.
   */
  debugMode?: boolean;
}

export function buildWorkflowStepEnvironment(input: {
  platformRoot?: string;
  projectRoot?: string;
  projectId?: string;
  workspaceRoot: string;
  runEnv?: Record<string, string>;
}): Record<string, string> {
  return {
    ...input.runEnv,
    ...(input.platformRoot ? { KB_PLATFORM_ROOT: input.platformRoot } : {}),
    ...(input.projectRoot ? { KB_PROJECT_ROOT: input.projectRoot } : {}),
    ...(input.projectId ? { KB_PROJECT_ID: input.projectId } : {}),
    KB_WORKSPACE_ROOT: input.workspaceRoot,
  };
}

export interface WorkflowWorker {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Create a workflow worker that processes jobs from the queue.
 * Uses SandboxRunner with ExecutionBackend for plugin execution.
 *
 * The worker is a pure orchestrator:
 * - Picks jobs from queue, iterates steps sequentially
 * - Delegates execution to backend.execute() (execution plane)
 * - Handles results, marks status, manages retry/failure
 *
 * All provisioning (workspace, environment, cleanup) is handled by the
 * execution plane transparently — the worker doesn't know or care.
 */
export async function createWorkflowWorker(
  options: CreateWorkflowWorkerOptions,
): Promise<WorkflowWorker> {
  const {
    engine,
    workflowService,
    cliApi,
    logger,
    platform,
    workspaceRoot,
    platformRoot = process.env["KB_PLATFORM_ROOT"],
    projectRoot = process.env["KB_PROJECT_ROOT"] ?? workspaceRoot,
    projectId,
    concurrency = 5,
    defaultTimeout,
    analytics,
    debugMode = process.env["WORKFLOW_DEBUG"] === "true",
  } = options;
  const workerLogger = createContextLogger(logger, {
    applicationId: "workflow-daemon",
    serviceId: "workflow",
    instanceId: `${process.pid}`,
    layer: "service",
  }).forComponent("workflow-worker").with({ projectId });

  // Clean up stale worktrees from previous daemon runs on startup.
  const wsProvider = platform.getAdapter<IWorkspaceProvider>("workspace");
  if (
    wsProvider &&
    typeof (wsProvider as { startupCleanup?: () => Promise<void> })
      .startupCleanup === "function"
  ) {
    (wsProvider as unknown as { startupCleanup: (projectRoot?: string) => Promise<void> })
      .startupCleanup(process.env["KB_PROJECT_ROOT"] ?? workspaceRoot)
      .catch(() => {});
  }

  let isRunning = false;
  let stopRequested = false;

  // Track running jobs for graceful shutdown
  const runningJobs = new Map<string, Promise<void>>();

  // In-process guard against double-processing the same (runId, jobId) job
  // when the queue happens to hold more than one entry for it at once (e.g.
  // a stale entry still in the queue racing a fresh retry/gate-restart
  // re-enqueue for the same job). This is a coarser guard than "don't
  // dequeue the same queue entry twice" — that race is now closed by the
  // lock inside Scheduler.dequeueFromPriority, which makes each entry
  // dequeue-once regardless of process count. This Set only needs to matter
  // *within* this process, since `concurrency` worker loops below poll
  // concurrently and could otherwise both pick up an entry for the same job.
  const claimedJobs = new Set<string>();

  // ExecutionBackend from platform — unified across all hosts (CLI, REST API, workflow)
  // In container mode this is a RoutingBackend; in standard mode — in-process/worker-pool.
  const executionBackend = platform.executionBackend;
  const secretProvider = options.secretProvider;

  // Create SandboxRunner with ExecutionBackend
  const runner = new SandboxRunner({
    backend: executionBackend,
    cliApi,
    workspaceRoot,
    platformRoot,
    defaultTimeout,
  });

  async function invokeChildWorkflow(input: {
    parentRun: WorkflowRun;
    parentJob: JobRun;
    parentStep: StepRun;
    workflowRef: string;
    inputs: Record<string, unknown>;
  }): Promise<void> {
    if (!workflowService) {
      throw new Error('Workflow invocation is unavailable: WorkflowService was not configured');
    }
    if (!input.workflowRef.startsWith('workspace:')) {
      throw new Error(`Unsupported child workflow reference: workflow:${input.workflowRef}`);
    }

    const workflowId = input.workflowRef.slice('workspace:'.length);
    const parentWorkflowId = requireWorkflowId(input.parentRun);
    const ancestors = (input.parentRun.metadata?.workflowAncestors as string[] | undefined) ?? [parentWorkflowId];
    if (ancestors.includes(workflowId)) {
      throw new Error(`Child workflow cycle detected: ${[...ancestors, workflowId].join(' -> ')}`);
    }
    const parentDepth = input.parentRun.metadata?.workflowDepth ?? 0;
    if (parentDepth >= engine.maxWorkflowDepth) {
      throw new Error(`Child workflow depth exceeds maxWorkflowDepth=${engine.maxWorkflowDepth}`);
    }

    const workflow = await workflowService.get(workflowId);
    const spec = workflow?.input as import('@kb-labs/workflow-contracts').WorkflowSpec | undefined;
    if (!workflow || !spec?.jobs) {
      throw new Error(`Child workflow not found or is not executable: ${workflowId}`);
    }

    const child = await engine.runFromSpec(spec, {
      trigger: {
        type: 'workflow',
        actor: input.parentRun.trigger.actor,
        payload: input.inputs,
        parentRunId: input.parentRun.id,
        parentJobId: input.parentJob.id,
        parentStepId: input.parentStep.id,
        invokedByWorkflowId: parentWorkflowId,
      },
      inputs: input.inputs,
      env: input.parentRun.env,
      metadata: {
        workflowId,
        parentRunId: input.parentRun.id,
        parentJobId: input.parentJob.id,
        parentStepId: input.parentStep.id,
        workflowDepth: parentDepth + 1,
        rootRunId: (input.parentRun.metadata?.rootRunId as string | undefined) ?? input.parentRun.id,
        workflowAncestors: [...ancestors, workflowId],
        // A composed quality workflow must inspect and repair the exact change
        // prepared by its parent, not a fresh worktree at main. The owner keeps
        // lifecycle responsibility; children only borrow this binding.
        executionWorkspace: input.parentRun.metadata?.['executionWorkspace'],
        workspaceOwnerRunId:
          (input.parentRun.metadata?.['workspaceOwnerRunId'] as string | undefined)
          ?? input.parentRun.id,
      },
    });

    await engine.markStepWaitingChild(input.parentRun.id, input.parentJob.id, input.parentStep.id, child.id);
    // Covers the race where a very small child completes before its parent
    // transition is persisted. Subsequent terminal events and daemon startup
    // use the same idempotent reconciliation path.
    await engine.reconcileChildInvocation(child.id);
  }

  /**
   * Process a single job from the queue.
   */
  async function processJob(): Promise<boolean> {
    const entry = await engine.nextJob();
    if (!entry) {
      return false; // No job available
    }

    // Get run and job from state store using IDs from queue entry
    const run = await engine.getRun(entry.runId);
    if (!run) {
      workerLogger.warn("Dequeued workflow job is missing from this project state", {
        runId: entry.runId,
        jobId: entry.jobId,
        projectId,
        outcome: "dropped",
      });
      return true; // Entry was processed (but run missing - data corruption)
    }

    const job = run.jobs.find((j) => j.id === entry.jobId);
    if (!job) {
      logger.error("Data inconsistency: Job not found in run", undefined, {
        runId: run.id,
        jobId: entry.jobId,
      });
      return true; // Entry was processed (but job missing - data corruption)
    }

    const jobKey = `${run.id}:${job.id}`;

    // See claimedJobs' declaration above for what this does and doesn't guard.
    if (claimedJobs.has(jobKey)) {
      return true; // Another loop already claimed this job
    }
    claimedJobs.add(jobKey);

    const waitMs = job.queuedAt
      ? Date.now() - new Date(job.queuedAt).getTime()
      : undefined;
    logger.info("Job picked from queue", {
      runId: run.id,
      jobId: job.id,
      jobName: job.jobName,
      queuedAt: job.queuedAt,
      waitMs,
    });

    const jobStartTime = Date.now();
    const declaredJobSecretNames = new Set([
      ...(run.secrets ?? []),
      ...getJobSecretNames(job),
    ]);
    const jobSecrets = await secretProvider.resolve([...declaredJobSecretNames]);
    registerProcessSensitiveValues(Object.values(jobSecrets));
    const jobLogger = createContextLogger(logger, {
      applicationId: "workflow-daemon",
      serviceId: "workflow",
      instanceId: `${process.pid}`,
      layer: "service",
    })
      .forComponent("workflow-worker")
      .forOperation("workflow.job", {
        requestId: run.id,
        traceId: run.id,
      })
      .with({
        "workflow.id": run.id,
        "workflow.run_id": run.id,
        "workflow.job_id": job.id,
        "workflow.job_name": job.jobName,
      });

    jobLogger.info("Processing job", {
      runId: run.id,
      jobId: job.id,
      jobName: job.jobName,
    });

    // Mark job as started (sets startedAt timestamp)
    await engine.markJobStarted(run.id, job.id);

    // Track job processing started
    analytics
      ?.track("workflow.worker.job.started", {
        runId: run.id,
        jobId: job.id,
        jobName: job.jobName,
        stepCount: job.steps.length,
      })
      .catch(() => {});

    // Resolve target hint from workflow spec (explicit override for execution plane)
    const runTarget = (run.metadata as Record<string, unknown> | undefined)
      ?.target as ExecutionTarget | undefined;
    const jobTarget = job.target as ExecutionTarget | undefined;
    const target = jobTarget ?? runTarget;

    // ── Workspace provisioning (worktree/container/remote) ──
    // If platform has a workspace provider, create an isolated workspace for this run.
    // All steps will execute in the provisioned workspace instead of the host workspace.
    const wsProvider = platform.getAdapter<IWorkspaceProvider>("workspace");
    // Without a workspace adapter, run steps in the project directory.
    // KB_PROJECT_ROOT is injected by kb-dev; fall back to workspaceRoot (platform dir) only
    // when running outside of kb-dev (e.g. tests or direct node invocation).
    let runWorkspace = wsProvider
      ? workspaceRoot
      : (process.env["KB_PROJECT_ROOT"] ?? workspaceRoot);
    let provisionedWorkspaceId: string | undefined;
    const workspaceMetadata = run.metadata?.['executionWorkspace'] as
      | { workspaceId?: unknown; rootPath?: unknown }
      | undefined;
    const inheritedWorkspace = typeof run.metadata?.['workspaceOwnerRunId'] === 'string'
      && run.metadata?.['workspaceOwnerRunId'] !== run.id;

    if (
      workspaceMetadata
      && typeof workspaceMetadata.rootPath === 'string'
      && typeof workspaceMetadata.workspaceId === 'string'
    ) {
      runWorkspace = workspaceMetadata.rootPath;
      // The owner releases once its terminal job completes. A child must never
      // release a borrowed worktree.
      provisionedWorkspaceId = inheritedWorkspace ? undefined : workspaceMetadata.workspaceId;
      jobLogger.info("Workspace binding restored", {
        workspaceId: workspaceMetadata.workspaceId,
        ownerRunId: run.metadata?.['workspaceOwnerRunId'] ?? run.id,
        inherited: inheritedWorkspace,
      });
    } else if (wsProvider) {
      const wsId = `wt_${run.id.slice(0, 8)}`;
      try {
        // Deterministic workspaceId per run — retries reuse the same worktree
        const ws = await wsProvider.materialize({
          workspaceId: wsId,
          projectRoot,
          platformRoot,
          metadata: { runId: run.id, jobId: job.id },
          onProgress: (event) => {
            jobLogger.info(`[workspace] ${event.stage}: ${event.message}`, {
              stage: event.stage,
              progress: event.progress,
            });
          },
        });
        if (ws.rootPath) {
          const rootPath = ws.rootPath;
          runWorkspace = rootPath;
          provisionedWorkspaceId = ws.workspaceId;
          await engine.getStateStore().updateRun(run.id, (draft) => {
            draft.metadata = {
              ...(draft.metadata ?? {}),
              executionWorkspace: { workspaceId: ws.workspaceId, rootPath },
              workspaceOwnerRunId: run.id,
            };
          });
          jobLogger.info("Workspace provisioned", {
            workspaceId: ws.workspaceId,
            provider: ws.provider,
            rootPath: ws.rootPath,
          });
        }
      } catch (wsError) {
        const msg =
          wsError instanceof Error ? wsError.message : String(wsError);
        logDiagnosticEvent(jobLogger, {
          domain: "workflow",
          event: "workflow.workspace.provision",
          level: "error",
          reasonCode: inferWorkspaceProvisionReasonCode(msg),
          message: "Workspace provisioning failed",
          outcome: "failed",
          error:
            wsError instanceof Error ? wsError : new Error(String(wsError)),
          serviceId: "workflow",
          stage: "materialize",
          evidence: {
            runId: run.id,
            jobId: job.id,
            workspaceId: wsId,
          },
        });
        const provisionErr = new Error(`Workspace provisioning failed: ${msg}`);
        await engine.markJobFailed(run.id, job.id, provisionErr);
        claimedJobs.delete(jobKey);
        return true;
      }
    }

    // Create job execution promise for graceful shutdown tracking
    // eslint-disable-next-line sonarjs/cognitive-complexity -- Step execution loop: handles data flow, spec.if, builtin:approval polling, builtin:gate routing with restart-from
    let failedStepFailure:
      | import("@kb-labs/core-contracts").ClassifiedFailure
      | undefined;
    let failedStepRetry:
      | (typeof job.steps)[number]["spec"]["retry"]
      | undefined;

    const jobPromise = (async () => {
      try {
        // Execute job steps using SandboxRunner
        // IMPORTANT: Steps MUST run sequentially because:
        // - Step outputs are inputs for next steps
        // - Steps may have side effects that depend on order
        // - Workflow semantics require sequential execution
        let wasCancelled = false;
        for (const step of job.steps) {
          if (step.status === "success") {
            continue; // Skip already completed steps
          }
          if (step.status === "waiting_child") {
            // The engine owns durable child reconciliation. A queued duplicate
            // must never create a second child run for the same parent step.
            return;
          }

          // --- Build ExpressionContext from fresh run state ---
          const freshRun = await engine.getRun(run.id);

          if (freshRun?.status === "cancelled") {
            jobLogger.info("[worker] Run cancelled — stopping step execution", {
              runId: run.id,
              jobId: job.id,
            });
            wasCancelled = true;
            break;
          }

          // A job marked terminal by something else (another daemon instance's
          // cleanupStaleRuns, a concurrent markJobFailed) must stop this loop
          // from continuing to execute steps and, critically, from calling
          // markJobCompleted/markJobFailed again at the end — that call would
          // try to overwrite an already-terminal status, which the state
          // machine now rejects, but by then it's better to never attempt it.
          // This is the direct fix for "job marked failed but still executing":
          // previously only run.status was ever re-checked here.
          const freshJob = freshRun?.jobs.find((j) => j.id === job.id);
          if (freshJob && isTerminal(freshJob.status, "job")) {
            jobLogger.warn("[worker] Job already in a terminal state — aborting in-process execution", {
              runId: run.id,
              jobId: job.id,
              status: freshJob.status,
            });
            return;
          }

          const exprCtx: ExpressionContext = {
            env: freshRun?.env ?? {},
            trigger: freshRun?.trigger ?? { type: "manual" },
            inputs: freshRun?.inputs ?? {},
            steps: {},
          };

          // Collect outputs from all completed steps (across all jobs).
          // Failed approval steps also expose their outputs so the following gate
          // can read `outputs.action === 'reject'` and route correctly.
          if (freshRun) {
            for (const j of freshRun.jobs) {
              for (const s of j.steps) {
                if (s.status === "success" && s.spec.id) {
                  exprCtx.steps[s.spec.id] = {
                    outputs: (s.outputs ?? {}) as Record<string, unknown>,
                  };
                } else if (
                  s.status === "failed" &&
                  s.spec.uses === "builtin:approval" &&
                  s.spec.id &&
                  s.outputs
                ) {
                  // Rejected approval — gate needs to see action/comment to route
                  exprCtx.steps[s.spec.id] = {
                    outputs: s.outputs as Record<string, unknown>,
                  };
                }
              }
            }
          }

          // --- Evaluate spec.if (skip step if condition is false) ---
          if (step.spec.if) {
            const condition = step.spec.if;
            // Strip ${{ }} wrapper if present
            const rawExpr = condition
              .trim()
              .replace(/^\$\{\{\s*/, "")
              .replace(/\s*\}\}$/, "");
            const shouldRun = evaluateExpression(rawExpr, exprCtx);
            if (!shouldRun) {
              jobLogger.info("[step] Skipped: condition evaluated to false", {
                runId: run.id,
                jobId: job.id,
                stepId: step.id,
                stepName: step.name,
                stepIndex: step.index,
                condition: rawExpr,
                evaluatedContext: {
                  inputKeys: Object.keys(exprCtx.inputs ?? {}),
                  stepKeys: Object.keys(exprCtx.steps),
                  envKeys: Object.keys(exprCtx.env),
                },
              });
              await engine.markStepCompleted(run.id, job.id, step.id, {
                skipped: true,
              });
              continue;
            }
          }

          // --- Interpolate spec.with (data flow between steps) ---
          // For builtin:shell steps: apply shell-safe command building so that user-supplied
          // values (e.g. issue titles containing backticks or $()) are injected as env vars
          // (_WF_* prefix) rather than substituted directly into the script string.
          // Shell expansion of ${VAR} does NOT re-evaluate backticks or $() in the value.
          let interpolatedWith = step.spec.with
            ? interpolateObject(
                step.spec.with as Record<string, unknown>,
                exprCtx,
              )
            : undefined;
          if (
            step.spec.uses === "builtin:shell" &&
            typeof step.spec.with?.["command"] === "string"
          ) {
            const rawCommand = step.spec.with["command"] as string;
            const { command: safeCommand, shellEnvVars } =
              buildShellSafeCommand(rawCommand, exprCtx);
            interpolatedWith = {
              ...(interpolatedWith ?? {}),
              command: safeCommand,
              env: {
                ...Object.fromEntries(
                  Object.entries(
                    (interpolatedWith?.["env"] as
                      | Record<string, unknown>
                      | undefined) ?? {},
                  ).map(([k, v]) => [k, coerceToString(v)]),
                ),
                ...shellEnvVars,
              },
            };
          }

          // --- Interpolate spec.env and forward to shell handler ---
          // step.spec.env values may contain ${{ }} expressions. Interpolate them
          // and pass as with.env so builtin:shell receives them in its environment.
          // coerceToString ensures object/array inputs become valid JSON strings
          // rather than "[object Object]" when assigned to env vars.
          const interpolatedEnvRaw = step.spec.env
            ? interpolateObject(
                step.spec.env as Record<string, unknown>,
                exprCtx,
              )
            : undefined;
          const interpolatedEnv: Record<string, string> | undefined =
            interpolatedEnvRaw
              ? Object.fromEntries(
                  Object.entries(interpolatedEnvRaw).map(([k, v]) => [
                    k,
                    coerceToString(v),
                  ]),
                )
              : undefined;

          const stepExecutionId = `wf-${run.id}-${job.id}-${step.id}-${Date.now()}`;
          const stepLogger = jobLogger.with({
            operation: "workflow.step",
            stepId: step.id,
            stepName: step.name,
            stepIndex: step.index,
            attempt: job.attempt ?? 1,
            executionId: stepExecutionId,
            spanId: stepExecutionId,
            invocationId: stepExecutionId,
          });
          const declaredStepSecretNames = new Set([
            ...(freshRun?.secrets ?? []),
            ...(freshJob?.secrets ?? []),
            ...getStepSecretNames(step.spec),
          ]);
          const stepSecretNames = [...declaredStepSecretNames];
          const stepSecrets = await secretProvider.resolve(stepSecretNames);
          registerProcessSensitiveValues(Object.values(stepSecrets));
          const unresolvedSecretName = stepSecretNames.find((name) => stepSecrets[name] === undefined);
          if (unresolvedSecretName !== undefined) {
            throw createMissingSecretError(secretProvider, unresolvedSecretName);
          }
          const stepEnvironment = projectStepEnvironment(buildWorkflowStepEnvironment({
            platformRoot,
            projectRoot,
            projectId,
            workspaceRoot: runWorkspace,
            runEnv: { ...(freshRun?.env ?? {}), ...(interpolatedEnv ?? {}) },
          }));
          const executionInputForLogs = {
            ...(interpolatedWith ?? {}),
            env: {
              ...((interpolatedWith?.env as Record<string, unknown> | undefined) ?? {}),
              ...stepEnvironment,
              ...stepSecrets,
            },
          };
          const safeStepLogger = stepLogger;

          // Debug input and expression records use the same secret-aware logger as
          // execution records so declared environment values cannot escape here.
          if (debugMode) {
            safeStepLogger.info("[debug] Expression context for step", {
              runId: run.id,
              jobId: job.id,
              stepId: step.id,
              stepUses: step.spec.uses,
              exprCtx: {
                inputKeys: Object.keys(exprCtx.inputs ?? {}),
                stepKeys: Object.keys(exprCtx.steps),
                envKeys: Object.keys(exprCtx.env),
              },
            });
          }
          if (debugMode && step.spec.with) {
            safeStepLogger.info("[debug] Step input interpolation", {
              runId: run.id,
              jobId: job.id,
              stepId: step.id,
              rawInput: summarizeWorkflowInput(step.spec.with ?? {}, stepSecretNames),
              resolvedInput: summarizeWorkflowInput(executionInputForLogs, stepSecretNames),
            });
          }

          // Persist resolved inputs into step.resolvedInputs — a separate field that
          // does NOT mutate spec.with. This preserves the original ${{ }} templates so
          // gate restartFrom cycles can re-interpolate the step correctly on each pass.
          if (interpolatedWith) {
            const stateStore = engine.getStateStore();
            await stateStore.updateStep(run.id, job.id, step.id, (draft) => {
              draft.resolvedInputs = interpolatedWith;
            });
          }

          safeStepLogger.info("Executing step", {
            runId: run.id,
            jobId: job.id,
            stepId: step.id,
            uses: step.spec.uses,
            // Keep input shape and env names while omitting ordinary and secret values.
            inputs: summarizeWorkflowInput(executionInputForLogs, stepSecretNames),
          });

          // --- Handle builtin:approval ---
          // Parks the step (and its parent job, atomically — see
          // markStepWaitingApproval) and returns from the worker job, same
          // pattern as nested workflow invocation below. This used to poll
          // in-process instead (a `while` loop sleeping 2s at a time),
          // which held this worker slot for the entire wait — with a
          // bounded pool (`concurrency`, default 5), enough concurrent
          // approvals starved every other job in the daemon, approval or
          // not. Parking releases the slot immediately; `resolveApproval`
          // re-enqueues the job once a human acts on it.
          if (step.spec.uses === "builtin:approval") {
            if (step.status === "failed") {
              // Already rejected (daemon restarted after resolution) — let gate route.
              safeStepLogger.info("Approval already rejected — skipping to gate", {
                runId: run.id,
                stepId: step.id,
              });
              continue;
            }
            if (step.status !== "waiting_approval") {
              await engine.markStepWaitingApproval(run.id, job.id, step.id);
            }
            safeStepLogger.info("[approval] Step parked awaiting human decision — releasing worker slot", {
              runId: run.id,
              jobId: job.id,
              stepId: step.id,
              stepName: step.name,
            });
            return;
          }

          // --- Handle nested workflow invocation ---
          // This parks the parent step and returns from the worker job. The
          // child monitor re-enqueues the parent only after the child is terminal,
          // avoiding a worker-pool deadlock when many parents invoke children.
          if (step.spec.uses?.startsWith("workflow:")) {
            await invokeChildWorkflow({
              parentRun: run,
              parentJob: job,
              parentStep: step,
              workflowRef: step.spec.uses.slice("workflow:".length),
              inputs: (interpolatedWith ?? {}) as Record<string, unknown>,
            });
            return;
          }

          // --- Handle builtin:gate ---
          if (step.spec.uses === "builtin:gate") {
            const gateInput = (interpolatedWith ?? {}) as unknown as GateInput;
            // Iteration counter lives in step.metadata so it survives restarts without
            // polluting run.metadata. Runs started before this change lose their counter
            // (reset to 0) — extra iterations are safer than silent skips.
            const currentIteration =
              (step.metadata?.["iterations"] as number) ?? 0;

            // Valid restart targets: steps within this job (same-job restart)
            // OR another job by name (cross-job restart — e.g. quality gate
            // routing back to `agent-execute`). Passing them lets the gate fail
            // honestly on a target that matches neither, instead of silently
            // completing (false green).
            const sameJobStepIds = job.steps.flatMap((s) =>
              [s.id, s.spec.id].filter(
                (v): v is string => typeof v === "string",
              ),
            );
            const jobNames = (freshRun?.jobs ?? run.jobs).map((j) => j.jobName);
            const validRestartTargets = [...sameJobStepIds, ...jobNames];

            const decision = new GateHandler().handle(
              gateInput,
              exprCtx,
              currentIteration,
              validRestartTargets,
            );
            safeStepLogger.info("[gate] Evaluating gate decision", {
              runId: run.id,
              stepId: step.id,
              stepName: step.name,
              expression: gateInput.decision,
              action: decision.action,
              iteration: currentIteration,
            });

            if (decision.action === "continue") {
              await engine.markStepCompleted(
                run.id,
                job.id,
                step.id,
                decision.outputs,
              );
              continue;
            }
            if (decision.action === "fail") {
              safeStepLogger.error(
                "[gate] Gate condition failed, aborting job",
                decision.error,
                {
                  runId: run.id,
                  stepId: step.id,
                  stepName: step.name,
                },
              );
              await engine.markStepFailed(
                run.id,
                job.id,
                step.id,
                decision.error,
                decision.outputs,
              );
              throw decision.error;
            }
            if (decision.action === "skip") {
              await applyGateSkip(engine, run, job, step, decision, stepLogger);
              return;
            }
            // restart
            await applyGateRestart(
              engine,
              run,
              job,
              step,
              decision,
              stepLogger,
            );
            return;
          }

          // --- Regular step execution ---
          // Mark step as started (sets startedAt timestamp)
          const stepStartTime = Date.now();
          await engine.markStepStarted(run.id, job.id, step.id);

          // Build spec with interpolated `with`, `run`, and `summary`.
          // Normalize `run: cmd` → `uses: builtin:shell, with: { command: cmd }`
          // Interpolate the run string so ${{ inputs.* }}, ${{ steps.* }} etc. are resolved.
          // StepSpec (post-zod-transform) may omit `run` after normalization, so work
          // with the StepSpecRaw shape here before re-casting to StepSpec for execution.
          // Note: run: blocks are normalized to uses: builtin:shell by the Zod schema transform
          // at parse time. Shell-safe command building for builtin:shell is applied above
          // via buildShellSafeCommand when computing interpolatedWith.
          let baseSpec: StepSpecRaw = step.spec as StepSpecRaw;
          if (baseSpec.run && !baseSpec.uses) {
            // Legacy path: step.spec was not normalized (should not happen after schema v2+)
            const { run: rawRun, with: existingWith, ...rest } = baseSpec;
            const { command, shellEnvVars } =
              typeof rawRun === "string"
                ? buildShellSafeCommand(rawRun, exprCtx)
                : { command: rawRun, shellEnvVars: {} };
            baseSpec = {
              ...rest,
              uses: "builtin:shell",
              with: {
                ...existingWith,
                command,
                env: {
                  ...((existingWith?.["env"] as
                    | Record<string, string>
                    | undefined) ?? {}),
                  ...shellEnvVars,
                },
              },
            };
          }
          // Interpolate the summary field so ${{ inputs.* }} resolves in step descriptions shown in Studio.
          if (typeof baseSpec.summary === "string") {
            baseSpec.summary = interpolateString(baseSpec.summary, exprCtx);
          }
          // Merge interpolated env into with.env for builtin:shell (ShellInput.env).
          const specWithEnv = interpolatedEnv
            ? {
                ...baseSpec,
                with: {
                  ...(baseSpec.with ?? {}),
                  env: {
                    ...((baseSpec.with?.["env"] as
                      | Record<string, string>
                      | undefined) ?? {}),
                    ...interpolatedEnv,
                  },
                },
              }
            : baseSpec;
          const interpolatedSpec = {
            ...specWithEnv,
            with: {
              ...(specWithEnv.with ?? {}),
              ...(interpolatedWith ?? {}),
              // Runtime/workflow env wins over with.env; secret references win over both.
              env: {
                ...((specWithEnv.with?.env as Record<string, string> | undefined) ?? {}),
                ...((interpolatedWith?.env as Record<string, string> | undefined) ?? {}),
                ...stepEnvironment,
                ...stepSecrets,
              },
            },
          };

          // Delegate execution to the execution plane.
          // The platform handles provisioning (workspace, environment, cleanup) transparently.
          const result = await runner.execute({
            spec: interpolatedSpec as StepSpec,
            context: {
              runId: run.id,
              jobId: job.id,
              stepId: step.id,
              attempt: 1,
              env: stepEnvironment,
              secrets: stepSecrets,
              logger: {
                debug: (message: string, meta?: Record<string, unknown>) =>
                  safeStepLogger.debug(message, meta),
                info: (message: string, meta?: Record<string, unknown>) =>
                  safeStepLogger.info(message, meta),
                warn: (message: string, meta?: Record<string, unknown>) =>
                  safeStepLogger.warn(message, meta),
                error: (message: string, meta?: Record<string, unknown>) =>
                  safeStepLogger.error(message, undefined, meta),
              },
              trace: {
                traceId: run.id,
                spanId: stepExecutionId,
                parentSpanId: job.id,
              },
              // The redacting step logger is the plugin logger base, with runId/jobId/stepId context.
              // See: services/workflow/docs/adr/0019-log-stream-separation.md
              loggerOverride: safeStepLogger,
              // ui/shell log entries: persist to SQLite with workflow context + publish for SSE.
              // See: services/workflow/docs/adr/0019-log-stream-separation.md
              onLog: (entry) => {
                safeStepLogger.info(entry.message, {
                  stream: entry.stream,
                  lineNo: entry.lineNo,
                  logSource: entry.stream === "stderr" ? "stderr" : "stdout",
                });
                void engine.publishLog(
                  run.id,
                  job.id,
                  step.id,
                  entry,
                  step.name,
                );
              },
              // ctx.logger.* entries: stepLogger base already wrote to SQLite. Only publish for SSE.
              // See: services/workflow/docs/adr/0019-log-stream-separation.md
              onLoggerLog: (entry) => {
                void engine.publishLog(
                  run.id,
                  job.id,
                  step.id,
                  entry,
                  step.name,
                );
              },
            },
            // Scripts (.kb/workflows/scripts/*.sh) live in the project root, not the worktree.
            // Use workspaceRoot as cwd so relative paths like `bash .kb/workflows/scripts/...`
            // resolve correctly. Scripts that need to operate inside the worktree cd into
            // KB_WORKSPACE_ROOT themselves (agent scripts, git operations).
            workspace: workspaceRoot,
            target,
          });

          if (result.status === "failed") {
            const stepDurationMs = Date.now() - stepStartTime;
            const error = Object.assign(
              new Error(result.error?.message ?? "Step execution failed"),
              {
                code: result.error?.code,
                hint: result.error?.hint,
                details: result.error?.details,
              },
            );

            // Mark step as failed (sets finishedAt timestamp + error)
            await engine.markStepFailed(run.id, job.id, step.id, error, result.outputs, result.failure);
            failedStepFailure = result.failure;
            failedStepRetry = step.spec.retry;

            safeStepLogger.error("Step failed", error, {
              runId: run.id,
              jobId: job.id,
              stepId: step.id,
              stepName: step.name,
              uses: step.spec.uses,
              durationMs: stepDurationMs,
              resolvedInputs: interpolatedWith,
              errorCode: result.error?.code,
            });

            if (step.continueOnError) {
              safeStepLogger.warn(
                "[step] continueOnError=true — continuing despite failure",
                {
                  runId: run.id,
                  jobId: job.id,
                  stepId: step.id,
                },
              );
              continue;
            }
            throw error;
          }

          const stepOutputs =
            result.status === "success" ? result.outputs : undefined;

          // Mark step as completed (sets finishedAt timestamp + outputs)
          await engine.markStepCompleted(run.id, job.id, step.id, stepOutputs);

          safeStepLogger.info("Step completed", {
            runId: run.id,
            jobId: job.id,
            stepId: step.id,
          });

          // Debug: show what outputs are now available to downstream steps
          if (debugMode && stepOutputs) {
            safeStepLogger.info("[debug] Step outputs", {
              runId: run.id,
              jobId: job.id,
              stepId: step.id,
              outputs: stepOutputs,
            });
          }
        }

        // Mark job terminal state: interrupted if run was cancelled, completed otherwise.
        if (wasCancelled) {
          await engine.markJobInterrupted(run.id, job.id);
          jobLogger.info("Job interrupted due to run cancellation", {
            runId: run.id,
            jobId: job.id,
          });
          return;
        }

        await engine.markJobCompleted(run.id, job.id);

        const jobDuration = Date.now() - jobStartTime;
        jobLogger.info("Job completed successfully", {
          runId: run.id,
          jobId: job.id,
        });

        // Track job processing completed
        analytics
          ?.track("workflow.worker.job.completed", {
            runId: run.id,
            jobId: job.id,
            jobName: job.jobName,
            durationMs: jobDuration,
            stepCount: job.steps.length,
          })
          .catch(() => {});

        // Release workspace on success (cleanup worktree)
        if (provisionedWorkspaceId && wsProvider) {
          try {
            await wsProvider.release(provisionedWorkspaceId);
            jobLogger.info("Workspace released", {
              workspaceId: provisionedWorkspaceId,
            });
          } catch (releaseErr) {
            jobLogger.warn("Workspace release failed", {
              workspaceId: provisionedWorkspaceId,
              error:
                releaseErr instanceof Error
                  ? releaseErr.message
                  : String(releaseErr),
            });
          }
        }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        const jobDuration = Date.now() - jobStartTime;

        const retryPolicy = failedStepRetry ?? job.retries;
        await engine.markJobFailed(
          run.id,
          job.id,
          err,
          failedStepFailure,
          retryPolicy,
        );

        // Track job processing failed
        analytics
          ?.track("workflow.worker.job.failed", {
            runId: run.id,
            jobId: job.id,
            jobName: job.jobName,
            errorMessage: err.message,
            durationMs: jobDuration,
          })
          .catch(() => {});

        // Keep workspace on failure for debugging
        if (provisionedWorkspaceId) {
          jobLogger.warn("Workspace kept for debugging", {
            workspaceId: provisionedWorkspaceId,
            path: runWorkspace,
          });
        }
      } finally {
        // Remove from tracking
        runningJobs.delete(jobKey);
        claimedJobs.delete(jobKey);
      }
    })();

    // Track running job
    runningJobs.set(jobKey, jobPromise);

    // Wait for completion
    await jobPromise;

    return true;
  }

  /**
   * Worker loop - continuously processes jobs from the queue.
   */
  async function workerLoop(): Promise<void> {
    // IMPORTANT: This is a polling loop, must run sequentially

    while (isRunning && !stopRequested) {
      try {
        const processed = await processJob();

        if (!processed) {
          // No job available, wait before polling again
          await sleep(1000);
        }
      } catch (error) {
        logDiagnosticEvent(logger, {
          domain: "workflow",
          event: "workflow.worker.loop",
          level: "error",
          reasonCode: "worker_loop_error",
          message: "Worker loop error",
          outcome: "failed",
          error: error instanceof Error ? error : new Error(String(error)),
          serviceId: "workflow",
          evidence: {
            errorMessage:
              error instanceof Error ? error.message : String(error),
            errorStack: error instanceof Error ? error.stack : undefined,
          },
        });
        await sleep(5000); // Wait longer on error
      }
    }

    logger.info("Worker loop stopped");
  }

  return {
    async start() {
      if (isRunning) {
        logger.warn("Worker already running");
        return;
      }

      logger.info("Starting workflow worker", { concurrency });
      isRunning = true;
      stopRequested = false;

      // Track worker start
      analytics
        ?.track("workflow.worker.started", {
          concurrency,
        })
        .catch(() => {});

      // Start multiple worker loops for concurrency
      const promises: Promise<void>[] = [];
      for (let i = 0; i < concurrency; i++) {
        promises.push(workerLoop());
      }

      await Promise.all(promises);
    },

    async stop() {
      if (!isRunning) {
        return;
      }

      logger.info("Stopping workflow worker", {
        runningJobsCount: runningJobs.size,
      });

      // Signal stop
      stopRequested = true;
      isRunning = false;

      // Wait for in-flight jobs to complete (graceful shutdown)
      if (runningJobs.size > 0) {
        logger.info("Waiting for in-flight jobs to complete", {
          count: runningJobs.size,
        });

        const shutdownTimeoutMs = parseInt(
          process.env.WORKFLOW_SHUTDOWN_TIMEOUT_MS || "120000",
          10,
        );

        try {
          // Wait for all running jobs with timeout
          await Promise.race([
            Promise.all(Array.from(runningJobs.values())),
            sleep(shutdownTimeoutMs),
          ]);

          if (runningJobs.size > 0) {
            logger.warn(
              "Shutdown timeout reached, marking jobs as interrupted",
              {
                count: runningJobs.size,
              },
            );

            // Mark unfinished jobs as interrupted (parallel for speed)
            await Promise.all(
              Array.from(runningJobs.keys()).map(async (jobKey) => {
                const [runId, jobId] = jobKey.split(":");
                if (runId && jobId) {
                  await engine.markJobInterrupted(runId, jobId);
                }
              }),
            );
          } else {
            logger.info("All in-flight jobs completed gracefully");
          }
        } catch (error) {
          logger.error(
            "Error during graceful shutdown",
            error instanceof Error ? error : undefined,
            {
              runningJobsCount: runningJobs.size,
            },
          );
        }
      }

      logger.info("Workflow worker stopped");

      // Track worker stop
      analytics
        ?.track("workflow.worker.stopped", {
          gracefulShutdown: runningJobs.size === 0,
          interruptedJobs: runningJobs.size,
        })
        .catch(() => {});
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}


type GateRestartDecision = Extract<GateDecision, { action: "restart" }>;
type GateSkipDecision = Extract<GateDecision, { action: "skip" }>;

/**
 * Apply gate skip: mark the gate and all intermediate steps as skipped, then re-enqueue the job.
 * The job loop will resume from skipTo because all preceding steps are already 'success'.
 * Called when GateHandler returns action='skip'.
 */
async function applyGateSkip(
  engine: WorkflowEngine,
  run: WorkflowRun,
  job: JobRun,
  step: Pick<StepRun, "id" | "name">,
  decision: GateSkipDecision,
  stepLogger: ILogger,
): Promise<void> {
  const { skipTo, outputs } = decision;

  stepLogger.info("[gate] Gate triggered skip-forward", {
    runId: run.id,
    stepId: step.id,
    stepName: step.name,
    skipTo,
  });

  const stateStore = engine.getStateStore();
  const scheduler = engine.getScheduler();

  // Mark the gate step itself as completed
  await engine.markStepCompleted(run.id, job.id, step.id, outputs);

  // Mark all steps between gate and skipTo target as skipped
  let pastGate = false;
  for (const s of job.steps) {
    if (s.id === step.id) {
      pastGate = true;
      continue; // gate is already marked completed above
    }
    if (!pastGate) {
      continue;
    }
    if (s.spec.id === skipTo || s.id === skipTo) {
      break;
    } // stop at target (inclusive — don't skip it)
    await stateStore.transitionStep(run.id, job.id, s.id, "success", (draft) => {
      draft.outputs = { skipped: true };
      draft.startedAt = new Date().toISOString();
      draft.finishedAt = new Date().toISOString();
    });
  }

  // Re-enqueue so the job loop restarts from a fresh snapshot and sees updated statuses
  const freshRun = await engine.getRun(run.id);
  const freshJob = freshRun?.jobs.find((j) => j.id === job.id);
  if (freshJob) {
    await scheduler.enqueueJob(run.id, freshJob, freshJob.priority ?? "normal");
  }

  stepLogger.info("[gate] Skip applied — re-enqueued job at skipTo target", {
    runId: run.id,
    skipTo,
  });
}

/**
 * Apply gate restart: persist iteration counter to step.metadata, reset steps to queued, re-enqueue job.
 * Called when GateHandler returns action='restart'.
 */
async function applyGateRestart(
  engine: WorkflowEngine,
  run: WorkflowRun,
  job: JobRun,
  step: Pick<StepRun, "id" | "name">,
  decision: GateRestartDecision,
  stepLogger: ILogger,
): Promise<void> {
  const { restartFrom, context, outputs, nextIteration } = decision;

  // Collect steps that will be reset for logging
  const stepsToReset: string[] = [];
  for (const s of job.steps) {
    if (s.spec.id === restartFrom || s.id === restartFrom) {
      stepsToReset.push(s.name ?? s.id);
    } else if (stepsToReset.length > 0) {
      stepsToReset.push(s.name ?? s.id);
    }
  }

  stepLogger.warn("[gate] Gate triggered restart", {
    runId: run.id,
    stepId: step.id,
    stepName: step.name,
    restartFrom,
    iteration: nextIteration,
    stepsToReset,
  });

  const stateStore = engine.getStateStore();
  const scheduler = engine.getScheduler();

  // Persist iteration counter on the gate step. The step reset below clears
  // status/timing/outputs but NOT metadata, so the counter survives.
  await stateStore.updateStep(run.id, job.id, step.id, (draft) => {
    draft.metadata = { ...(draft.metadata ?? {}), iterations: nextIteration };
  });

  // Merge rework feedback into trigger.payload so the restarted job's steps can
  // read it via ${{ trigger.payload.* }} — this survives the reset (whereas
  // steps.*.outputs do not, once the producing steps are reset to queued).
  if (context) {
    await engine.updateRun(run.id, (draft) => {
      const payload = (draft.trigger.payload ?? {}) as Record<string, unknown>;
      Object.assign(payload, context);
      draft.trigger.payload = payload;
      return draft;
    });
  }

  // Is restartFrom a step in THIS job (same-job) or another job by name (cross-job)?
  const sameJobTarget = job.steps.some(
    (s) => s.spec.id === restartFrom || s.id === restartFrom,
  );

  if (!sameJobTarget) {
    // ── Cross-job restart (e.g. quality gate → agent-execute) ────────────────
    // Reset the target job and every job transitively downstream of it
    // (including this gate's own job), then re-enqueue the target. When it
    // completes, the engine releases its blocked dependents in DAG order:
    // agent re-runs (with feedback) → quality re-runs → gate re-evaluates.
    const fresh = (await engine.getRun(run.id)) ?? run;
    const resetNames = new Set<string>([restartFrom]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const j of fresh.jobs) {
        if (resetNames.has(j.jobName)) {
          continue;
        }
        if ((j.needs ?? []).some((n) => resetNames.has(n))) {
          resetNames.add(j.jobName);
          changed = true;
        }
      }
    }

    for (const rj of fresh.jobs) {
      if (!resetNames.has(rj.jobName)) {
        continue;
      }
      // A reset job re-blocks only on needs that are themselves being reset;
      // dependencies outside the reset set already completed and stay satisfied.
      const pending = (rj.needs ?? []).filter((n) => resetNames.has(n));
      for (const s of rj.steps) {
        // allowReset: a gate restart can reset steps that already succeeded
        // (redoing prior work after rework feedback) — that's a deliberate
        // bulk reset, not a normal forward transition.
        await stateStore.transitionStep(run.id, rj.id, s.id, "queued", (draft) => {
          draft.startedAt = undefined;
          draft.finishedAt = undefined;
          draft.error = undefined;
          draft.outputs = undefined;
        }, { allowReset: true });
      }
      // allowReset: same reasoning — a previously succeeded/cancelled job
      // can be reset back to queued for a re-run.
      await stateStore.transitionJob(run.id, rj.id, "queued", (draft) => {
        draft.startedAt = undefined;
        draft.finishedAt = undefined;
        draft.pendingDependencies = [...pending];
        draft.blocked = pending.length > 0;
      }, { allowReset: true });
    }

    const refreshed = await engine.getRun(run.id);
    const targetJob = refreshed?.jobs.find((j) => j.jobName === restartFrom);
    if (targetJob && !targetJob.blocked) {
      await scheduler.enqueueJob(
        run.id,
        targetJob,
        targetJob.priority ?? "normal",
      );
    }
    stepLogger.warn("[gate] Cross-job restart re-enqueued target", {
      runId: run.id,
      restartFrom,
      iteration: nextIteration,
      resetJobs: [...resetNames],
    });
    return;
  }

  // ── Same-job restart ───────────────────────────────────────────────────────
  await engine.markStepCompleted(run.id, job.id, step.id, outputs);

  let foundTarget = false;
  for (const s of job.steps) {
    if (s.spec.id === restartFrom || s.id === restartFrom) {
      foundTarget = true;
    }
    if (foundTarget) {
      // allowReset: same as the cross-job case — resetting an already-
      // succeeded step back to queued for a restart iteration.
      await stateStore.transitionStep(run.id, job.id, s.id, "queued", (draft) => {
        draft.startedAt = undefined;
        draft.finishedAt = undefined;
        draft.error = undefined;
        draft.outputs = undefined;
      }, { allowReset: true });
    }
  }

  // The job itself is still 'running' at this point (this is happening
  // inside its own in-flight step loop) — running -> queued is an ordinary
  // legal transition, no reset needed.
  await stateStore.transitionJob(run.id, job.id, "queued", (draft) => {
    draft.startedAt = undefined;
    draft.finishedAt = undefined;
  });

  const updatedRun = await engine.getRun(run.id);
  const updatedJob = updatedRun?.jobs.find((j) => j.id === job.id);
  if (updatedJob) {
    await scheduler.enqueueJob(
      run.id,
      updatedJob,
      updatedJob.priority ?? "normal",
    );
    stepLogger.info("[gate] Job re-enqueued for restart", {
      runId: run.id,
      jobId: job.id,
      jobName: job.jobName,
      iteration: nextIteration,
      restartFrom,
    });
  }
}

function inferWorkspaceProvisionReasonCode(message: string) {
  return /ETIMEDOUT|timeout/iu.test(message)
    ? "workspace_provision_timeout"
    : "workspace_provision_failed";
}
