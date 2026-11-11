import {
  launchPlatform,
  type PlatformAssemblyHook,
  type PlatformContainer,
  type PlatformFailurePolicy,
  type PlatformRuntime,
  type PlatformUiProvider,
} from "@kb-labs/core-runtime";
import {
  resolveServiceListenAddress,
  type IContextLogger,
  type IServiceTransport,
} from "@kb-labs/core-platform";
import { ActiveWorkRegistry } from "./active-work.js";

export interface ServiceContext {
  platform: PlatformContainer;
  logger: IContextLogger;
  port: number;
  host: string;
  /**
   * Local port shift (KB_NET_OFFSET), resolved once by the launcher. 0 in
   * cloud/k8s. Edge services that own their port config add it themselves.
   */
  netOffset: number;
  runtime: PlatformRuntime;
  platformRoot: string;
  projectRoot?: string;
  projectId?: string;
  activeWork: ActiveWorkRegistry;
}

type ServiceSetup = (
  ctx: ServiceContext,
) => Promise<() => Promise<void>>;

interface NetworkServiceConfig {
  appId: string;
  /**
   * serviceId in the declarative transport map. Defaults to appId.
   * Edge services that are not in the map use defaultPort + KB_NET_OFFSET.
   */
  serviceId?: string;
  defaultPort?: number;
  portEnvVar?: string;
  defaultHost?: string;
  hostEnvVar?: string;
}

interface PlatformLaunchOptions {
  assemblyHook: PlatformAssemblyHook;
  failurePolicy?: PlatformFailurePolicy;
  loadEnv?: boolean;
  storeRawConfig?: boolean;
  uiProvider?: PlatformUiProvider;
  hostServiceEnvironment?: import('@kb-labs/core-platform').HostServiceEnvironment;
  executionHealth?: NonNullable<Parameters<typeof launchPlatform>[0]['executionHealth']>;
}

export interface ServiceConfig extends NetworkServiceConfig {
  /** Starting directory for project/platform root resolution. */
  startDir?: string;
  /** Project identity scope owned by this process entry point. */
  projectScope: "required" | "platform";
  /** Registry identity required when projectScope is `required`. */
  projectId?: string;
  /** Entrypoint import.meta.url for installed-mode platform discovery. */
  moduleUrl?: string;
  platform: PlatformLaunchOptions;
  /**
   * Runs after the platform is ready. The returned teardown is always called
   * before PlatformRuntime.shutdown().
   */
  setup: ServiceSetup;
}

/**
 * One service body that can run inside a host process.
 *
 * A module carries what it needs to resolve its own address and to start its
 * work. It never launches the platform and never owns process signals or
 * `process.exit`: those belong to {@link runHost}.
 */
export interface HostModule extends Omit<NetworkServiceConfig, "appId"> {
  /** Stable module id used in diagnostics; also the serviceId when `serviceId` is omitted. */
  id: string;
  /**
   * Runs after the platform is ready. The returned teardown is called in
   * reverse start order, before platform shutdown.
   */
  setup: ServiceSetup;
}

/** Identity helper that gives a module literal its type. */
export function defineHostModule(module: HostModule): HostModule {
  return module;
}

export interface HostConfig {
  appId: string;
  /** serviceId used for the single platform launch. Defaults to appId. */
  serviceId?: string;
  /** Starting directory for project/platform root resolution. */
  startDir?: string;
  /** Project identity scope owned by this process entry point. */
  projectScope: "required" | "platform";
  /** Registry identity required when projectScope is `required`. */
  projectId?: string;
  /** Entrypoint import.meta.url for installed-mode platform discovery. */
  moduleUrl?: string;
  platform: PlatformLaunchOptions;
  /** Started in array order, torn down in reverse order. */
  modules: readonly HostModule[];
}

function resolveNetwork(
  module: Omit<HostModule, "setup">,
  platform: PlatformContainer,
  netOffset: number,
): { port: number; host: string } {
  const transport = platform.getAdapter<IServiceTransport>("serviceTransport");
  return resolveServiceListenAddress(
    transport,
    {
      serviceId: module.serviceId ?? module.id,
      ...(module.portEnvVar ? { portEnvVar: module.portEnvVar } : {}),
      ...(module.portEnvVar ? { portEnvValue: process.env[module.portEnvVar] } : {}),
      ...(module.defaultPort !== undefined ? { defaultPort: module.defaultPort } : {}),
      ...(module.hostEnvVar ? { hostEnvValue: process.env[module.hostEnvVar] } : {}),
      ...(module.defaultHost ? { defaultHost: module.defaultHost } : {}),
    },
    netOffset,
  );
}

interface StartedModule {
  id: string;
  teardown: () => Promise<void>;
}

/**
 * Runs the teardowns in reverse start order. Every teardown is attempted even
 * when an earlier one fails; the first error is returned.
 */
async function teardownModules(
  started: readonly StartedModule[],
  logger: IContextLogger,
  multi: boolean,
): Promise<unknown> {
  let firstError: unknown;
  for (const module of [...started].reverse()) {
    try {
      await module.teardown();
    } catch (error) {
      firstError ??= error;
      logger.error(
        "Service teardown failed",
        error instanceof Error ? error : undefined,
        {
          event: "service.failed",
          phase: "teardown",
          ...(multi ? { moduleId: module.id } : {}),
        },
      );
    }
  }
  return firstError;
}

/**
 * Composable process launcher.
 *
 * Launches the platform exactly once, starts every module's setup() in array
 * order, and owns the single set of SIGTERM/SIGINT handlers and the single
 * `process.exit`. On a signal, modules are torn down in reverse order and then
 * the platform is shut down. If a setup fails, the modules already started are
 * torn down, the platform is shut down, and the error is rethrown.
 */
export async function runHost(config: HostConfig): Promise<void> {
  const runtime = await launchPlatform({
    applicationId: config.appId,
    serviceId: config.serviceId ?? config.appId,
    kind: "service",
    startDir: config.startDir,
    projectScope: config.projectScope,
    projectId: config.projectId,
    moduleUrl: config.moduleUrl,
    assemblyHook: config.platform.assemblyHook,
    failurePolicy: config.platform.failurePolicy,
    loadEnv: config.platform.loadEnv,
    storeRawConfig: config.platform.storeRawConfig,
    uiProvider: config.platform.uiProvider,
    hostServiceEnvironment: config.platform.hostServiceEnvironment,
    executionHealth: config.platform.executionHealth,
  });

  const logger = runtime.logger.forComponent("service-bootstrap");
  const netOffset = Number(process.env.KB_NET_OFFSET) || 0;
  const multi = config.modules.length > 1;
  const started: StartedModule[] = [];
  const activeWork = new ActiveWorkRegistry();

  for (const module of config.modules) {
    const { port, host } = resolveNetwork(module, runtime.platform, netOffset);
    const moduleField = multi ? { moduleId: module.id } : {};

    logger.event("info", {
      event: "service.starting",
      message: "Service starting",
      fields: { port, host, ...moduleField },
    });

    try {
      const teardown = await module.setup({
        runtime,
        platform: runtime.platform,
        logger,
        port,
        host,
        netOffset,
        projectRoot: runtime.roots.projectRoot,
        platformRoot: runtime.roots.platformRoot,
        projectId: config.projectId,
        activeWork,
      });
      started.push({ id: module.id, teardown });
    } catch (error) {
      logger.error(
        "Service setup failed",
        error instanceof Error ? error : undefined,
        {
          event: "service.failed",
          error: error instanceof Error ? error.message : String(error),
          ...moduleField,
        },
      );
      await teardownModules(started, logger, multi);
      await runtime.shutdown("service.setup-failed");
      throw error;
    }

    logger.event("info", {
      event: "service.ready",
      message: "Service ready",
      fields: { port, host, outcome: "success", ...moduleField },
    });
  }

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (signal: string): Promise<void> => {
    shutdownPromise ??= (async () => {
      logger.event("info", {
        event: "service.stopping",
        message: "Service stopping",
        fields: { signal },
      });

      let shutdownError = await teardownModules(started, logger, multi);

      try {
        await runtime.shutdown(`signal:${signal}`);
      } catch (error) {
        shutdownError ??= error;
        logger.error(
          "Platform shutdown failed",
          error instanceof Error ? error : undefined,
          {
            event: "service.failed",
            phase: "platform-shutdown",
          },
        );
      }

      const exitCode = shutdownError ? 1 : 0;
      logger.event(shutdownError ? "error" : "info", {
        event: shutdownError ? "service.failed" : "service.stopped",
        message: shutdownError
          ? "Service stopped with errors"
          : "Service stopped",
        fields: {
          signal,
          exitCode,
          outcome: shutdownError ? "failure" : "success",
        },
      });
      process.exit(exitCode);
    })();
    return shutdownPromise;
  };

  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

/**
 * Canonical service process launcher.
 *
 * Every service gets the same roots/env/config/platform lifecycle. Service code
 * starts only inside setup(), after PlatformRuntime is ready. This is the
 * one-module case of {@link runHost}.
 */
export async function runService(config: ServiceConfig): Promise<void> {
  const { appId, startDir, moduleUrl, projectScope, projectId, platform, setup, ...network } = config;
  await runHost({
    appId,
    serviceId: network.serviceId ?? appId,
    startDir,
    projectScope,
    projectId,
    moduleUrl,
    platform,
    modules: [{ ...network, id: appId, setup }],
  });
}
