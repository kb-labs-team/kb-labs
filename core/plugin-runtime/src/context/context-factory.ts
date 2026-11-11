/**
 * Plugin Context Factory
 *
 * Creates the full PluginContextV3 from a descriptor and platform services.
 */

import type {
  PluginContextV3,
  PluginContextDescriptor,
  PlatformServices,
  PluginServices,
  UIFacade,
  CleanupFn,
  ProcessIdentity,
} from "@kb-labs/plugin-contracts";
import { getLoggerMetadataFromHost } from "@kb-labs/plugin-contracts";
import { createContextLogger, createErrorEnvelope } from "@kb-labs/core-platform";

import { createId } from "../utils/index.js";
import { createTraceContext } from "./trace.js";
import { createRuntimeAPI } from "../runtime/index.js";
import {
  createPluginAPI,
  type EventEmitterFn,
  type PluginInvokerFn,
  type CreatePluginAPIOptions,
} from "../api/index.js";
import { applyPluginGovernance } from "../platform/pipeline.js";
import type { LoadedMiddleware } from "../platform/pipeline.js";
import { createStreamingLogger } from "./streaming-logger.js";
import { createStreamingUI } from "./streaming-ui.js";

export interface CreateContextOptions {
  /**
   * Plugin context descriptor (from IPC)
   */
  descriptor: PluginContextDescriptor;

  /**
   * Platform services
   */
  platform: PlatformServices;

  /**
   * UI facade for output
   */
  ui: UIFacade;

  /**
   * Abort signal for cancellation
   */
  signal?: AbortSignal;

  /**
   * Event emitter function (optional)
   */
  eventEmitter?: EventEmitterFn;

  /**
   * Plugin invoker function (optional)
   */
  pluginInvoker?: PluginInvokerFn;

  /**
   * Current working directory (from WorkspaceLease)
   */
  cwd: string;

  /**
   * Output directory for artifacts (optional)
   */
  outdir?: string;

  /** Environment values explicitly supplied for this execution. */
  environment?: Record<string, string | undefined>;

  /** Enforce only the manifest's filesystem patterns, with no local defaults. */
  strictFilesystemPermissions?: boolean;

  /**
   * Resolved adapter middlewares from loaded adapter manifests.
   * Applied in slot/priority order before system governance.
   */
  adapterMiddlewares?: LoadedMiddleware[];
}

export interface CreateContextResult<TConfig = unknown> {
  /**
   * The created context
   */
  context: PluginContextV3<TConfig>;

  /**
   * Cleanup stack (for executing cleanups after handler completes)
   */
  cleanupStack: Array<CleanupFn>;

  /**
   * Request ID for this execution
   */
  requestId: string;

  /**
   * Trace ID (propagated or new)
   */
  traceId: string;

  /**
   * Span ID (unique to this execution)
   */
  spanId: string;
}

/**
 * Create a full PluginContextV3
 */
export function createPluginContextV3<TConfig = unknown>(
  options: CreateContextOptions,
): CreateContextResult<TConfig> {
  const {
    descriptor,
    platform,
    ui,
    signal,
    eventEmitter,
    pluginInvoker,
    cwd,
    outdir,
    adapterMiddlewares,
  } = options;

  // 1. Build stable correlation IDs.
  // Preserve incoming request/trace when available to keep cross-node correlation intact.
  const requestId = descriptor.requestId || createId();
  const hostTraceId =
    "traceId" in descriptor.hostContext &&
    typeof descriptor.hostContext.traceId === "string"
      ? descriptor.hostContext.traceId
      : undefined;
  const descriptorMeta = descriptor as unknown as Record<string, unknown>;
  const traceId =
    (typeof descriptorMeta.traceId === "string"
      ? descriptorMeta.traceId
      : undefined) ||
    hostTraceId ||
    requestId;
  const spanId =
    (typeof descriptorMeta.spanId === "string"
      ? descriptorMeta.spanId
      : undefined) || createId();
  const invocationId =
    (typeof descriptorMeta.invocationId === "string"
      ? descriptorMeta.invocationId
      : undefined) || spanId;
  const executionId =
    typeof descriptorMeta.executionId === "string"
      ? descriptorMeta.executionId
      : undefined;

  // 2. Create cleanup stack
  const cleanupStack: Array<CleanupFn> = [];

  // 3. Create trace context (no parent tracking in V3)
  const trace = createTraceContext({
    traceId,
    spanId,
    parentSpanId: undefined,
    logger: platform.logger,
  });

  // 4. Create runtime API (sandboxed fs, fetch, env)
  const runtime = createRuntimeAPI({
    pluginId: descriptor.pluginId,
    permissions: descriptor.permissions,
    cwd,
    outdir,
    environment: options.environment,
    strictFilesystemPermissions: options.strictFilesystemPermissions,
  });

  // 5. Apply adapter middlewares + permission governance to platform services.
  // Middlewares run first (in slot/priority order), governance wraps last.
  // IMPORTANT: Must be done BEFORE passing platform to handlers.
  const governedPlatform = applyPluginGovernance(
    platform,
    descriptor.permissions,
    descriptor.pluginId,
    adapterMiddlewares ?? [],
  );

  // 5.1. Enrich logger with host context (observability fields)
  const loggerMeta = getLoggerMetadataFromHost(descriptor.hostContext);
  const protectedLogger = createContextLogger(governedPlatform.logger, {
    applicationId: String(loggerMeta.applicationId ?? "plugin-runtime"),
    serviceId: String(loggerMeta.serviceId ?? "plugin-runtime"),
    instanceId: String(loggerMeta.instanceId ?? `${process.pid}`),
    layer: String(loggerMeta.layer ?? descriptor.hostContext.host),
  })
    .with({
      ...loggerMeta,
      requestId,
      traceId,
      spanId,
      invocationId,
      executionId,
      handlerId: descriptor.handlerId,
    })
    .forPlugin({ pluginId: descriptor.pluginId });

  // 5.2. If eventEmitter provided (workflow host), wrap logger to also stream log calls as events
  const finalLogger = eventEmitter
    ? createStreamingLogger(protectedLogger, eventEmitter)
    : protectedLogger;

  // 5.3. If eventEmitter provided, also wrap UI to stream ui.info/warn/error/write calls
  const streamedUI = eventEmitter ? createStreamingUI(ui, eventEmitter) : ui;
  const finalUI = descriptor.hostType === "cli"
    ? {
        ...streamedUI,
        json: () => { throw commandUIContractViolation('json'); },
        error: () => { throw commandUIContractViolation('error'); },
      }
    : streamedUI;

  const enrichedPlatform: PluginServices = {
    ...governedPlatform,
    logger: finalLogger,
  };

  // 6. Create plugin API
  // Use governed cache so permissions are enforced for api.state
  const finalOutdir = outdir ?? `${cwd}/.kb/output`;

  // These optional services exist on PlatformContainer but are not declared on
  // PlatformServices (IPlatformAdapters), which only covers core adapter fields.
  // We narrow via a local intersection using the exact types expected by CreatePluginAPIOptions.
  const extendedPlatform = platform as PlatformServices & {
    processExecutor?: CreatePluginAPIOptions["processExecutor"];
    hasResourceBroker?: boolean;
    workflows?: CreatePluginAPIOptions["workflowEngine"];
    environmentManager?: CreatePluginAPIOptions["environmentManager"];
    workspaceManager?: CreatePluginAPIOptions["workspaceManager"];
    snapshotManager?: CreatePluginAPIOptions["snapshotManager"];
  };

  const api = createPluginAPI({
    pluginId: descriptor.pluginId,
    handlerId: descriptor.handlerId,
    tenantId: descriptor.tenantId,
    cwd,
    outdir: finalOutdir,
    permissions: descriptor.permissions,
    processExecutor: extendedPlatform.processExecutor,
    processIdentity: {
      executionId: executionId ?? requestId,
      requestId,
      pluginId: descriptor.pluginId,
      handlerId: descriptor.handlerId,
      tenantId: descriptor.tenantId,
    },
    signal,
    cache: enrichedPlatform.cache, // Use governed cache, not raw
    eventEmitter,
    pluginInvoker,
    // Access workflows from platform container (if available)
    workflowEngine: extendedPlatform.workflows,
    // Jobs/Cron use HTTP client to Workflow Service (microservices architecture)
    workflowServiceUrl: process.env.KB_WORKFLOW_SERVICE_URL,
    // Environment lifecycle goes through runtime EnvironmentManager when available.
    // Returns undefined on proxy/minimal platforms where these services are absent.
    environmentManager: extendedPlatform.environmentManager,
    workspaceManager: extendedPlatform.workspaceManager,
    snapshotManager: extendedPlatform.snapshotManager,
    analytics: enrichedPlatform.analytics,
    eventBus: enrichedPlatform.eventBus,
    logger: enrichedPlatform.logger,
    cleanupStack,
  });

  // 7. Assemble full context
  // Platform services passed through with enriched logger
  const context: PluginContextV3<TConfig> = {
    // Metadata
    host: descriptor.hostType,
    requestId,
    pluginId: descriptor.pluginId,
    pluginVersion: descriptor.pluginVersion,
    tenantId: descriptor.tenantId,
    cwd,
    outdir: finalOutdir,
    config: undefined, // Config comes from platform.config, not descriptor

    // Cancellation
    signal,
    ...(eventEmitter ? {
      onProcessStarted: async (identity: ProcessIdentity) => {
        await eventEmitter('process.started', identity);
      },
    } : {}),

    // Tracing
    trace,

    // Host-specific
    hostContext: descriptor.hostContext,

    // Services
    ui: finalUI,
    platform: enrichedPlatform, // ← Platform with enriched logger
    runtime,
    api,
  };

  return {
    context,
    cleanupStack,
    requestId,
    traceId,
    spanId,
  };
}

function commandUIContractViolation(method: 'json' | 'error'): Error & { code: string; hint: string } {
  const envelope = createErrorEnvelope('KB_PLUGIN_CONTRACT_VIOLATION', {
    message: `Plugin command called ctx.ui.${method}().`,
  });
  return Object.assign(new Error(envelope.message), {
    code: envelope.code,
    hint: envelope.hint,
  });
}
