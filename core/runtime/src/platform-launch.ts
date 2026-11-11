/**
 * @module @kb-labs/core-runtime/platform-launch
 *
 * Canonical platform launch path shared by services, CLI hosts and workers.
 *
 * This module owns platform concerns only:
 * - layered config and environment loading;
 * - adapter initialisation and assembly;
 * - application-scoped logging context;
 * - startup diagnostics and idempotent platform shutdown.
 *
 * Process concerns such as OS signals, exit codes and service-specific teardown
 * deliberately belong to the caller (for example @kb-labs/shared-daemon).
 */

import { hostname } from "node:os";
import {
  createContextLogger,
  createProcessRootLogContext,
  type HostServiceEnvironment,
  type IContextLogger,
  type ILogReader,
} from "@kb-labs/core-platform";
import { getAdapterStatus, type AdapterSlotStatus } from "./adapter-status.js";
import { isWorkspaceDevelopmentMode } from "./platform-mode.js";
import {
  platform,
  type PlatformContainer,
  type PlatformLifecycleContext,
  type PlatformLifecycleHooks,
  type PlatformLifecyclePhase,
} from "./container.js";
import type { PlatformConfig } from "./config.js";
import {
  loadPlatformConfig,
  type LoadPlatformConfigOptions,
  type LoadPlatformConfigResult,
} from "./config-loader.js";
import { initPlatform, resetPlatform } from "./loader.js";
import { requireProjectContext } from "./project-context.js";
import { resolveDeploymentTopology } from "./config-schemas.js";

export type PlatformApplicationKind = "service" | "cli" | "worker" | "test";
export type PlatformFailurePolicy = "strict" | "degraded";

export type PlatformAssemblyHook = NonNullable<
  NonNullable<Parameters<typeof initPlatform>[4]>['assemblyHook']
>;
export type PlatformUiProvider = NonNullable<
  Parameters<typeof initPlatform>[2]
>;

export interface PlatformLaunchOptions {
  /** Stable identity used for lifecycle and root logger bindings. */
  applicationId: string;
  /** Service identity when one application exposes a differently named network service. */
  serviceId?: string;
  /** Runtime surface. It affects policy, never the ILogger contract. */
  kind: PlatformApplicationKind;
  /** Directory used to resolve project and platform roots. */
  startDir?: string;
  /** Whether startup should resolve a registered current project. */
  projectScope?: 'required' | 'platform';
  /** Registered project identity for a process with required project scope. */
  projectId?: string;
  /** Entrypoint import.meta.url, useful in installed mode. */
  moduleUrl?: string;
  /** Load layered .env files before config interpolation. @default true */
  loadEnv?: boolean;
  /** Publish raw/effective config through the compatibility globals. @default true */
  storeRawConfig?: boolean;
  /** Behaviour when configured platform initialisation fails. @default strict */
  failurePolicy?: PlatformFailurePolicy;
  /** Host-specific UI provider used by execution backends. */
  uiProvider?: PlatformUiProvider;
  /** Host addresses needed by this process's own adapters, passed without global env mutation. */
  hostServiceEnvironment?: HostServiceEnvironment;
  /** Optional health observation exposed by this host's execution backend. */
  executionHealth?: LoadPlatformConfigOptions['executionHealth'];
  /** Required platform assembly pipeline. */
  assemblyHook: PlatformAssemblyHook;
}

export interface PlatformRoots {
  platformRoot: string;
  projectRoot?: string;
  sameLocation: boolean;
}

export interface PlatformStartupReport {
  applicationId: string;
  kind: PlatformApplicationKind;
  status: "ready" | "degraded";
  durationMs: number;
  configFound: boolean;
  sources: LoadPlatformConfigResult["sources"];
  adapters: AdapterSlotStatus[];
  error?: string;
}

export interface PlatformRuntime {
  application: {
    id: string;
    kind: PlatformApplicationKind;
  };
  platform: PlatformContainer;
  catalog: LoadPlatformConfigResult['catalog'];
  logger: IContextLogger;
  /** Read side of the platform log system for diagnostics and tooling. */
  readonly logs: ILogReader;
  platformConfig: PlatformConfig;
  rawConfig?: Record<string, unknown>;
  effectiveConfig?: Record<string, unknown>;
  roots: PlatformRoots;
  startupReport: PlatformStartupReport;
  shutdown(reason?: string): Promise<void>;
}

let activeRuntime: PlatformRuntime | undefined;
let activeLaunch: Promise<PlatformRuntime> | undefined;

function registerLifecycleLogging(
  applicationId: string,
  serviceId: string,
  kind: PlatformApplicationKind,
  instanceId: string,
): void {
  const hookId = `platform-launch:${applicationId}`;
  if (platform.listLifecycleHookIds().includes(hookId)) {
    return;
  }

  const lifecycleLogger = () =>
    createContextLogger(platform.logger, {
      applicationId,
      serviceId,
      instanceId,
      layer: kind,
    }).forComponent("platform-lifecycle");

  const hooks: PlatformLifecycleHooks = {
    onStart(context: PlatformLifecycleContext) {
      lifecycleLogger().event("debug", {
        event: "platform.starting",
        message: "Platform lifecycle start",
        fields: {
          cwd: context.cwd,
        },
      });
    },
    onReady(context: PlatformLifecycleContext) {
      lifecycleLogger().event("info", {
        event: "platform.ready",
        message: "Platform lifecycle ready",
        fields: { durationMs: context.metadata?.durationMs },
      });
    },
    onBeforeShutdown(context: PlatformLifecycleContext) {
      lifecycleLogger().event("debug", {
        event: "platform.stopping",
        message: "Platform lifecycle before shutdown",
        fields: { reason: context.reason },
      });
    },
    onShutdown(context: PlatformLifecycleContext) {
      lifecycleLogger().event("info", {
        event: "platform.stopped",
        message: "Platform lifecycle shutdown",
        fields: { reason: context.reason },
      });
    },
    onError(error: unknown, phase: PlatformLifecyclePhase) {
      lifecycleLogger().error(
        "Platform lifecycle failed",
        error instanceof Error ? error : undefined,
        {
          event: "platform.failed",
          phase,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    },
  };

  platform.registerLifecycleHooks(hookId, hooks);
}

function publishConfigGlobals(
  loadResult: LoadPlatformConfigResult,
  storeRawConfig: boolean,
): void {
  if (!storeRawConfig) {
    return;
  }

  const target = globalThis as Record<string, unknown>;
  target.__KB_PLATFORM_CONFIG__ = loadResult.platformConfig;
  target.__KB_RAW_CONFIG__ = loadResult.rawConfig;
  target.__KB_EFFECTIVE_CONFIG__ =
    loadResult.effectiveConfig ?? loadResult.rawConfig;
}

async function launch(
  options: PlatformLaunchOptions,
): Promise<PlatformRuntime> {
  const {
    applicationId,
    serviceId = applicationId,
    kind,
    startDir = process.cwd(),
    moduleUrl,
    loadEnv = true,
    storeRawConfig = true,
    failurePolicy = "strict",
    uiProvider,
    hostServiceEnvironment,
    assemblyHook,
  } = options;

  const startedAt = Date.now();
  const instanceId = `${hostname()}:${process.pid}`;
  const processLogContext = createProcessRootLogContext({
    applicationId,
    serviceId,
    instanceId,
    layer: kind,
  });
  platform.setAdapter('logger', createContextLogger(platform.logger, processLogContext));
  registerLifecycleLogging(applicationId, serviceId, kind, instanceId);

  const loadResult = await loadPlatformConfig({
    moduleUrl,
    startDir,
    loadEnvFile: loadEnv,
    projectScope: options.projectScope,
    projectId: options.projectId,
    executionHealth: options.executionHealth,
  });
  publishConfigGlobals(loadResult, storeRawConfig);

  const {
    platformConfig,
    rawConfig,
    effectiveConfig,
    platformRoot,
    projectRoot,
    sameLocation,
    sources,
  } = loadResult;
  if (kind === 'service' || kind === 'worker') {
    resolveDeploymentTopology(effectiveConfig ?? rawConfig);
  }
  const adapterProjectRoot = loadResult.projectScope === 'platform'
    ? platformRoot
    : requireProjectContext(projectRoot, options.startDir);

  let effectivePlatformConfig = platformConfig;
  let status: PlatformStartupReport["status"] = "ready";
  let startupError: string | undefined;

  try {
    await initPlatform(
      platformConfig,
      adapterProjectRoot,
      uiProvider,
      adapterProjectRoot === platformRoot ? undefined : platformRoot,
      {
        assemblyHook,
        hostServiceEnvironment,
        workspaceDevelopment: isWorkspaceDevelopmentMode(loadResult),
        workspaceRoot: projectRoot,
        catalog: loadResult.catalog,
      },
    );
  } catch (error) {
    if (failurePolicy === "strict") {
      throw error;
    }

    status = "degraded";
    startupError = error instanceof Error ? error.message : String(error);
    effectivePlatformConfig = { adapters: {} };
    await initPlatform(
      effectivePlatformConfig,
      adapterProjectRoot,
      uiProvider,
      undefined,
      {
        assemblyHook,
        hostServiceEnvironment,
        workspaceDevelopment: isWorkspaceDevelopmentMode(loadResult),
        workspaceRoot: projectRoot,
        catalog: loadResult.catalog,
      },
    );
  }

  const logger = createContextLogger(platform.logger, {
    applicationId,
    serviceId,
    instanceId,
    layer: kind,
  });
  // The process-wide container is the surface used by plugins and legacy
  // platform modules. Installing the wrapper here makes their logs inherit the
  // same identity as logs emitted through PlatformRuntime.logger.
  platform.setAdapter("logger", logger);
  const configFound = Boolean(
    sources.platformDefaults || sources.projectConfig,
  );
  const startupReport: PlatformStartupReport = {
    applicationId,
    kind,
    status,
    durationMs: Date.now() - startedAt,
    configFound,
    sources,
    adapters: getAdapterStatus(),
    ...(startupError ? { error: startupError } : {}),
  };

  if (status === "degraded") {
    logger.event("warn", {
      event: "platform.ready",
      message: "Platform launched in degraded mode",
      fields: {
        outcome: "degraded",
        error: startupError,
        platformRoot,
        projectRoot,
      },
    });
  } else {
    logger.event("info", {
      event: "platform.ready",
      message: "Platform launched",
      fields: {
        outcome: "success",
        platformRoot,
        projectRoot,
        configFound,
        durationMs: startupReport.durationMs,
      },
    });
  }

  let shutdownPromise: Promise<void> | undefined;
  const runtime: PlatformRuntime = {
    application: { id: applicationId, kind },
    platform,
    catalog: loadResult.catalog,
    logger,
    get logs() {
      return platform.logs;
    },
    platformConfig: effectivePlatformConfig,
    rawConfig,
    effectiveConfig,
    roots: {
      platformRoot,
      projectRoot,
      sameLocation,
    },
    startupReport,
    shutdown(reason = "platform-runtime.shutdown") {
      shutdownPromise ??= loadResult.catalog.dispose().then(() => platform.shutdown()).finally(() => {
        logger.event("info", {
          event: "platform.stopped",
          message: "Platform runtime stopped",
          fields: { reason, outcome: "success" },
        });
      });
      return shutdownPromise;
    },
  };

  return runtime;
}

/**
 * Launch the process-wide platform runtime.
 *
 * Calls are idempotent for the same application. Launching a second
 * application identity in one process is rejected because PlatformContainer is
 * intentionally process-scoped.
 */
export async function launchPlatform(
  options: PlatformLaunchOptions,
): Promise<PlatformRuntime> {
  if (activeRuntime) {
    if (
      activeRuntime.application.id !== options.applicationId ||
      activeRuntime.application.kind !== options.kind
    ) {
      throw new Error(
        `Platform is already launched for "${activeRuntime.application.id}" ` +
          `(${activeRuntime.application.kind}); cannot relaunch it for ` +
          `"${options.applicationId}" (${options.kind}) in the same process.`,
      );
    }
    return activeRuntime;
  }

  activeLaunch ??= launch(options)
    .then((runtime) => {
      activeRuntime = runtime;
      return runtime;
    })
    .catch((error) => {
      activeLaunch = undefined;
      throw error;
    });

  return activeLaunch;
}

/** Return the active runtime, if launchPlatform() has completed. */
export function getPlatformRuntime(): PlatformRuntime | undefined {
  return activeRuntime;
}

/** Test-only reset for the launch state and process-wide platform singleton. */
export function resetPlatformRuntime(): void {
  activeRuntime = undefined;
  activeLaunch = undefined;
  resetPlatform();
}
