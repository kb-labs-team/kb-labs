/**
 * @module @kb-labs/workflow-daemon/bootstrap
 * Bootstrap workflow daemon - initialize platform, engine, worker, and HTTP server
 */

import { makeAssemblyHook } from "@kb-labs/plugin-runtime";
import {
  WorkflowEngine,
  WorkflowService,
  DAEMON_LEASE_HEARTBEAT_INTERVAL_MS,
  createDefaultSecretProvider,
  requireWorkflowProjectId,
} from "@kb-labs/workflow-engine";
import { getListenOptions } from "@kb-labs/shared-http";
import { runService, type ServiceContext } from "@kb-labs/shared-daemon";
import { createWorkflowWorker } from "./worker.js";
import { JobBroker } from "./job-broker.js";
import { CronScheduler } from "./cron-scheduler.js";
import { CronDiscovery } from "./cron-discovery.js";
import { WorkflowFileWatcher } from "./file-watcher.js";
import { createServer } from "./server.js";
import { requireProjectContext } from "@kb-labs/core-runtime";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createWorkflowActiveWorkProvider } from "./active-work.js";

/**
 * Bootstrap workflow daemon.
 * Initializes platform, engine, worker, and HTTP server.
 */
export async function bootstrap(_cwd: string = process.cwd()): Promise<void> {
  await runService({
    appId: "workflow-daemon",
    projectScope: "required",
    projectId: process.env["KB_PROJECT_ID"],
    startDir: _cwd,
    // serviceId in the transport map / devservices is 'workflow' (≠ appId).
    serviceId: "workflow",
    defaultPort: 7778,
    portEnvVar: "WORKFLOW_PORT",
    defaultHost: "127.0.0.1",
    hostEnvVar: "WORKFLOW_HOST",
    platform: {
      assemblyHook: makeAssemblyHook(),
    },
    setup,
  });
}

/**
 * Workflow daemon service body. Importable and side-effect-free: it only
 * starts work when called with a resolved {@link ServiceContext} (by
 * `runService` here, or by `runHost` in a project runtime).
 */
export async function setup({
  platform,
  runtime,
  port,
  host,
  projectRoot,
  projectId: contextProjectId,
  platformRoot,
  activeWork,
  logger: serviceLogger,
}: ServiceContext): Promise<() => Promise<void>> {
  const projectId = requireWorkflowProjectId(contextProjectId);
  // KB_PROJECT_ROOT is injected by kb-dev when invoked from a project dir with separate platform.
  const workspaceRoot = requireProjectContext(process.env["KB_PROJECT_ROOT"] ?? projectRoot);

  const startupRequestId = `workflow-startup-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const startupTraceId = randomUUID();
  const startupSpanId = randomUUID();
  const bootstrapLogger = serviceLogger
    .forComponent("workflow-bootstrap")
    .forOperation("workflow.bootstrap", {
      requestId: startupRequestId,
      traceId: startupTraceId,
      spanId: startupSpanId,
    })
    .with({ invocationId: startupSpanId, executionId: startupSpanId });

  if (!platform.isConfigured("workspace")) {
    bootstrapLogger.warn("Workspace adapter is not configured", {
      impact: "Workflows using balanced or strict isolation will fail.",
      remediation:
        "Configure platform.adapters.workspace or use relaxed isolation.",
    });
  }

  if (
    !platform.isConfigured("environment") &&
    platform.isConfigured("workspace")
  ) {
    bootstrapLogger.warn("Environment adapter is not configured", {
      impact: "Workflows using strict isolation will fail.",
      remediation: "Configure platform.adapters.environment.",
    });
  }

  const debugMode = process.env["WORKFLOW_DEBUG"] === "true";
  bootstrapLogger.info("Workflow daemon starting", {
    projectRoot: workspaceRoot,
    debugMode,
  });

  if (debugMode) {
    bootstrapLogger.warn(
      "[WORKFLOW_DEBUG=true] Verbose debug logging is ON — step inputs, outputs, and expr contexts will be logged. " +
        "Disable in production (unset WORKFLOW_DEBUG or set to false).",
    );
  }

  const createWorkflowLogger = (
    service: string,
    operation: string,
    bindings?: Record<string, unknown>,
  ) =>
    serviceLogger
      .forComponent(`workflow-${service}`)
      .forOperation(operation)
      .with(bindings ?? {});

  bootstrapLogger.info("Loading plugin registry snapshot");
  const cliApi = runtime.catalog;
  const plugins = await cliApi.listPlugins();
  bootstrapLogger.info("Plugin registry snapshot loaded", {
    pluginsFound: plugins.length,
    pluginIds: plugins.map((p) => `${p.id}@${p.version}`),
  });

  bootstrapLogger.info("Creating WorkflowEngine");
  const secretProvider = createDefaultSecretProvider();
  const engine = new WorkflowEngine({
    cache: platform.cache,
    storage: platform.storage,
    events: platform.eventBus,
    logger: createWorkflowLogger("engine", "workflow.engine"),
    secretProvider,
    snapshotManager: platform.snapshotManager,
    workspaceRoot,
    projectId,
  });
  const unregisterActiveWork = activeWork.register(
    "workflow",
    createWorkflowActiveWorkProvider(engine.getStateStore()),
  );

  bootstrapLogger.info(
    "Cleaning up stale runs from previous daemon process",
  );
  await engine.cleanupStaleRuns();

  // Keep this instance's daemon liveness lease fresh for as long as the
  // process stays up — cleanupStaleRuns (on any future daemon launch
  // against this same store, including a stray/duplicate one) uses a
  // still-fresh lease under a different instanceId as its sole signal
  // that it must not touch this daemon's runs.
  const leaseHeartbeat = setInterval(() => {
    engine.renewDaemonLease().catch((error) => {
      bootstrapLogger.warn("Failed to renew daemon liveness lease", {
        err: error instanceof Error ? error.message : String(error),
      });
    });
  }, DAEMON_LEASE_HEARTBEAT_INTERVAL_MS);
  leaseHeartbeat.unref?.();

  bootstrapLogger.info("Resuming interrupted jobs");
  await engine.resumeInterruptedJobs();

  bootstrapLogger.info("Reconciling persisted child workflow invocations");
  const reconciledChildren = await engine.reconcileChildInvocations();
  if (reconciledChildren > 0) {
    bootstrapLogger.info("Reconciled child workflow invocations", { count: reconciledChildren });
  }

  bootstrapLogger.info("Creating JobBroker");
  const jobBroker = new JobBroker(
    engine,
    createWorkflowLogger("job-broker", "workflow.job-broker"),
    platform,
  );

  bootstrapLogger.info("Creating CronScheduler");
  const cronScheduler = new CronScheduler({
    jobBroker,
    workflowEngine: engine,
    logger: createWorkflowLogger(
      "cron-scheduler",
      "workflow.cron-scheduler",
    ),
    timezone: process.env.WORKFLOW_CRON_TIMEZONE,
  });

  bootstrapLogger.info("Creating WorkflowService");
  const workflowService = new WorkflowService({
    cliApi,
    platform,
    workspaceRoot,
  });

  bootstrapLogger.info("Discovering cron jobs");
  const cronDiscovery = new CronDiscovery({
    cliApi,
    scheduler: cronScheduler,
    logger: createWorkflowLogger(
      "cron-discovery",
      "workflow.cron-discovery",
    ),
    workspaceRoot,
    workflowService,
  });
  const discovered = await cronDiscovery.discoverAll();
  bootstrapLogger.info("Cron job discovery complete", discovered);

  workflowService
    .listAll()
    .catch((err: unknown) =>
      bootstrapLogger.warn("Manifest scanner warmup failed", { err }),
    );

  bootstrapLogger.info("Starting WorkflowFileWatcher");
  const fileWatcher = new WorkflowFileWatcher({
    watchDirs: [
      join(workspaceRoot, ".kb", "workflows"),
      join(workspaceRoot, ".kb", "crons"),
    ],
    workflowService,
    cronDiscovery,
    cronScheduler,
    logger: createWorkflowLogger("file-watcher", "workflow.file-watcher"),
  });

  bootstrapLogger.info("Creating HTTP server");
  const server = await createServer({
    engine,
    jobBroker,
    workflowService,
    cronScheduler,
    cronDiscovery,
    logger: createWorkflowLogger("api", "workflow.api"),
  });

  await server.listen(getListenOptions(port, host));
  bootstrapLogger.info("HTTP API listening", { port });

  bootstrapLogger.info("Creating WorkflowWorker");
  const worker = await createWorkflowWorker({
    engine,
    secretProvider,
    workflowService,
    cliApi,
    logger: createWorkflowLogger("worker", "workflow.worker"),
    analytics: platform.analytics,
    platform,
    workspaceRoot,
    platformRoot,
    projectRoot,
    projectId,
    concurrency: parseInt(process.env.WORKFLOW_CONCURRENCY ?? "5", 10),
    debugMode,
  });

  bootstrapLogger.info("Starting WorkflowWorker");
  worker.start().catch((error) => {
    bootstrapLogger.error(
      "Worker crashed - shutting down daemon",
      error instanceof Error ? error : undefined,
    );
    process.kill(process.pid, "SIGTERM");
  });

  bootstrapLogger.info("Starting CronScheduler");
  await cronScheduler.start();

  bootstrapLogger.info("Workflow daemon started successfully", { port });

  return async () => {
    bootstrapLogger.warn("Stopping workflow daemon components");
    unregisterActiveWork();
    clearInterval(leaseHeartbeat);
    fileWatcher.close();
    await cronScheduler.stop();
    await worker.stop();
    await server.close();
    // Platform shutdown is owned by runService after this callback returns.
  };
}
