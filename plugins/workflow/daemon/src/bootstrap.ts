/**
 * @module @kb-labs/workflow-daemon/bootstrap
 * Bootstrap workflow daemon - initialize platform, engine, worker, and HTTP server
 */

import { makeAssemblyHook } from "@kb-labs/plugin-runtime";
import {
  WorkflowEngine,
  WorkflowService,
  DAEMON_LEASE_HEARTBEAT_INTERVAL_MS,
} from "@kb-labs/workflow-engine";
import { getListenOptions } from "@kb-labs/shared-http";
import { runService, type ServiceContext } from "@kb-labs/shared-daemon";
import { createWorkflowWorker } from "./worker.js";
import { JobBroker } from "./job-broker.js";
import { CronScheduler } from "./cron-scheduler.js";
import { CronDiscovery } from "./cron-discovery.js";
import { WorkflowFileWatcher } from "./file-watcher.js";
import { createServer } from "./server.js";
import { createRegistry } from "@kb-labs/core-registry";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

/**
 * Bootstrap workflow daemon.
 * Initializes platform, engine, worker, and HTTP server.
 */
export async function bootstrap(_cwd: string = process.cwd()): Promise<void> {
  await runService({
    appId: "workflow-daemon",
    startDir: _cwd,
    // serviceId in the transport map / devservices is 'workflow' (≠ appId).
    serviceId: "workflow",
    defaultPort: 7778,
    portEnvVar: "WORKFLOW_PORT",
    defaultHost: "0.0.0.0",
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
  port,
  host,
  projectRoot,
  platformRoot,
  logger: serviceLogger,
}: ServiceContext): Promise<() => Promise<void>> {
  // KB_PROJECT_ROOT injected by kb-dev when invoked from a project dir with separate platform.
  // Fall back to the resolved repoRoot (not raw cwd) so plugin/cron/workflow discovery is
  // correct even when the daemon is launched from a subdirectory.
  const workspaceRoot = process.env["KB_PROJECT_ROOT"] ?? projectRoot;

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
  const cliApi = await createRegistry({
    root: workspaceRoot,
    platformRoot,
    cache: { ttlMs: 10 * 60 * 1000 },
  });
  await cliApi.initialize();
  const plugins = await cliApi.listPlugins();
  bootstrapLogger.info("Plugin registry snapshot loaded", {
    pluginsFound: plugins.length,
    pluginIds: plugins.map((p) => `${p.id}@${p.version}`),
  });

  bootstrapLogger.info("Creating WorkflowEngine");
  const engine = new WorkflowEngine({
    cache: platform.cache,
    events: platform.eventBus,
    logger: createWorkflowLogger("engine", "workflow.engine"),
    snapshotManager: platform.snapshotManager,
    workspaceRoot,
  });

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

  bootstrapLogger.info("Discovering cron jobs");
  const cronDiscovery = new CronDiscovery({
    cliApi,
    scheduler: cronScheduler,
    logger: createWorkflowLogger(
      "cron-discovery",
      "workflow.cron-discovery",
    ),
    workspaceRoot,
  });
  const discovered = await cronDiscovery.discoverAll();
  bootstrapLogger.info("Cron job discovery complete", discovered);

  bootstrapLogger.info("Creating WorkflowService");
  const workflowService = new WorkflowService({
    cliApi,
    platform,
    workspaceRoot,
  });
  workflowService
    .listAll()
    .catch((err: unknown) =>
      bootstrapLogger.warn("Manifest scanner warmup failed", { err }),
    );

  bootstrapLogger.info("Starting WorkflowFileWatcher");
  const fileWatcher = new WorkflowFileWatcher({
    watchDirs: [
      join(workspaceRoot, ".kb", "workflows"),
      join(workspaceRoot, ".kb", "jobs"),
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
    workflowService,
    cliApi,
    logger: createWorkflowLogger("worker", "workflow.worker"),
    analytics: platform.analytics,
    platform,
    workspaceRoot,
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
    clearInterval(leaseHeartbeat);
    fileWatcher.close();
    await cronScheduler.stop();
    await worker.stop();
    await server.close();
    await cliApi.dispose();
    // Platform shutdown is owned by runService after this callback returns.
  };
}
