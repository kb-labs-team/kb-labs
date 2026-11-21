/**
 * @module @kb-labs/host-app/host
 *
 * The machine-level host: ONE process, ONE platform launch, ONE external port.
 *
 * It composes the gateway, the marketplace service and the state daemon as
 * {@link HostModule}s of `runHost`. Only the gateway listens on a public
 * address (service transport, `GATEWAY_PORT`, or module default plus offset); marketplace and state bind
 * ephemeral loopback ports that the host resolves itself and injects in-process
 * into the gateway's service transport, so no module addresses are written in
 * config. See ADR-0043 and docs/architecture/target/04-topology.md.
 */

import { createRequire } from "node:module";
import type { HttpServiceTransport } from "@kb-labs/adapters-service-transport-http";
import { loadEffectiveConfig, validatePlatformAdapterOptions } from "@kb-labs/core-config";
import {
  GATEWAY_SERVICE_NETWORK,
  AdapterConfigError,
  catalogEnvironmentVariables,
  resolveServiceListenAddress,
  type IServiceTransport,
} from "@kb-labs/core-platform";
import { createProjectRegistry, resolvePlatformDataRoot } from "@kb-labs/core-project-registry";
import type { IProjectRegistry } from "@kb-labs/core-project-registry";
import type { PlatformAssemblyHook } from "@kb-labs/core-runtime";
import {
  isLoopbackHost,
  loadGatewayConfig,
  resolveGatewayConfigRoot,
  startGateway,
  type HostRoutes,
} from "@kb-labs/gateway-app";
import { setup as setupMarketplace } from "@kb-labs/marketplace-app";
import { setup as setupState } from "@kb-labs/core-state-daemon";
import {
  installPlatformResolveHook,
  makeAssemblyHook,
  type PlatformResolveHook,
} from "@kb-labs/plugin-runtime";
import {
  defineHostModule,
  runHost,
  type HostConfig,
  type HostModule,
  type ServiceContext,
} from "@kb-labs/shared-daemon";
import { applyHostGatewayPolicy, type GatewayUpstreams } from "./policy.js";
import { MarketplaceClient } from "./marketplace-client.js";
import { createChildProcessLauncher } from "./project-runtime/launcher.js";
import { createProjectServiceTransport } from "./project-runtime/service-transport.js";
import { PROJECT_SERVICE_DECLARATIONS } from "@kb-labs/project-runtime-app";
import {
  ProjectRuntimeManager,
  type ProjectRuntimeManagerOptions,
  type RuntimeLauncher,
} from "./project-runtime/manager.js";
import { createProjectRouting } from "./project-runtime/routing.js";
import { findScheduledProjects } from "./project-runtime/workflow-schedules.js";
import { createProjectsRoutes } from "./projects-routes.js";
import { createPluginsRoutes } from "./plugins-routes.js";
import { startHostActiveWorkControl } from "./active-work-control.js";
import {
  parseHostSettings,
  type HostModuleId,
  type HostSettings,
} from "./settings.js";
import {
  createGeneratedTransport,
  HostServiceTransport,
  INTERNAL_BIND_HOST,
} from "./transport.js";

export const HOST_APP_ID = "kb-host";
const GATEWAY_CONFIG_SCOPE = "platform" as const;

type Teardown = () => Promise<void>;

interface InternalModuleSpec {
  id: Exclude<HostModuleId, "gateway">;
  /** Key in the service transport map; what the gateway upstream points at. */
  serviceId: string;
  upstreamName: string;
  prefix: string;
  rewritePrefix?: string;
  setup: (ctx: ServiceContext, platformDataRoot: string) => Promise<Teardown>;
}

const INTERNAL_MODULES: readonly InternalModuleSpec[] = [
  {
    id: "marketplace",
    serviceId: "marketplace",
    upstreamName: "marketplace",
    prefix: "/api/v1/marketplace",
    setup: setupMarketplace,
  },
  {
    id: "state",
    serviceId: "state-daemon",
    upstreamName: "state",
    prefix: "/api/v1/state",
    // The state daemon serves /state/* and /health at its root.
    rewritePrefix: "",
    setup: setupState,
  },
];

/** What the first module to start resolves once, for every module. */
interface PreparedHost {
  settings: HostSettings;
  upstreams: GatewayUpstreams;
  platformDataRoot: string;
  gatewayAddress?: string;
}

function isSelected(settings: HostSettings, id: HostModuleId): boolean {
  return settings.modules.includes(id);
}

/** An internal module must publish the loopback address it actually bound. */
function assertInternalAddress(
  ctx: ServiceContext,
  serviceId: string,
  generated: HttpServiceTransport,
): void {
  const address = generated.listenAddress(serviceId);
  if (!address || !("port" in address) || address.port === 0) {
    throw new Error(
      `The host service transport has no TCP address for "${serviceId}"; has not published its bound address.`,
    );
  }
  if (!isLoopbackHost(ctx.host)) {
    throw new Error(
      `Internal module "${serviceId}" would bind "${ctx.host}"; internal modules bind loopback only.`,
    );
  }
}

/**
 * The internal loopback base URL for a co-located module (ADR-0043), or
 * `undefined` when the transport has no TCP address for it — e.g. the module
 * is disabled by `host.modules`. Used to reach the marketplace module
 * directly, without a second gateway hop.
 */
function internalBaseUrl(generated: HttpServiceTransport, serviceId: string): string | undefined {
  const address = generated.listenAddress(serviceId);
  if (!address || !("port" in address)) {
    return undefined;
  }
  return `http://127.0.0.1:${address.port}`;
}

/** Registers several {@link HostRoutes} plugins on the same gateway instance, in order. */
function combineHostRoutes(...routes: HostRoutes[]): HostRoutes {
  return async (app) => {
    for (const route of routes) {
      await app.register(route);
    }
  };
}

function generatedUpstreams(settings: HostSettings): GatewayUpstreams {
  const upstreams: GatewayUpstreams = {};
  for (const spec of INTERNAL_MODULES) {
    if (!isSelected(settings, spec.id)) {continue;}
    upstreams[spec.upstreamName] = {
      serviceId: spec.serviceId,
      prefix: spec.prefix,
      ...(spec.rewritePrefix !== undefined
        ? { rewritePrefix: spec.rewritePrefix }
        : {}),
    };
  }
  return upstreams;
}

/**
 * Overrides for the project runtime supervisor. Everything has a default taken
 * from the `host` settings; this exists for embedding and tests.
 */
export interface ProjectRuntimeOverrides
  extends Partial<
    Pick<
      ProjectRuntimeManagerOptions,
      | "idleTimeoutMs"
      | "startTimeoutMs"
      | "startPollMs"
      | "healthIntervalMs"
      | "healthFailureThreshold"
      | "sweepIntervalMs"
      | "restart"
    >
  > {
  /** Replaces the child-process launcher. */
  launcher?: RuntimeLauncher;
  /** Script started with node for each runtime; defaults to the `kb-project-runtime` bin. */
  entry?: string;
  /** SIGTERM grace period of the default launcher before SIGKILL. */
  stopTimeoutMs?: number;
}

export interface HostOptions {
  /** Starting directory for project/platform root resolution. */
  startDir?: string;
  /** Entrypoint import.meta.url for installed-mode platform discovery. */
  moduleUrl?: string;
  /** Machine-level project registry; defaults to the one under `KB_HOME` (`~/.kb`). */
  projectRegistry?: IProjectRegistry;
  projectRuntime?: ProjectRuntimeOverrides;
}

/** The `kb-project-runtime` executable that ships with this install. */
function defaultRuntimeEntry(): string {
  return createRequire(import.meta.url).resolve(
    "@kb-labs/project-runtime-app/bin",
  );
}

/**
 * Builds the `runHost` configuration. Async because the internal loopback
 * module addresses are published after each module binds port 0. Each call
 * returns an independent host: nothing here is module-global.
 */
export async function createHostConfig(
  options: HostOptions = {},
): Promise<HostConfig> {
  let stateDaemonUrl: string | undefined;
  const hostServiceEnvironment = { KB_STATE_DAEMON_URL: undefined as string | undefined };
  const generated = createGeneratedTransport({});

  const baseHook = makeAssemblyHook();
  const assemblyHook: PlatformAssemblyHook = (platform, broker, config) => {
    const assembled = baseHook(platform, broker, config);
    // An explicit `adapterOptions.serviceTransport` was already loaded into
    // the container; keep it authoritative for the ids it knows.
    const configured = platform.getAdapter<IServiceTransport>("serviceTransport");
    return {
      ...assembled,
      serviceTransport: new HostServiceTransport(generated, configured),
    };
  };

  // One platform per process: plugins loaded from outside the platform root get
  // the host's copy of the platform packages (ADR-0048 D5). Released at the
  // start of host teardown, before awaiting any module cleanup, so even a
  // stalled module cannot leave it installed for the next host in this process.
  let resolveHook: PlatformResolveHook | undefined;
  const releaseResolveHook = (): void => {
    resolveHook?.deregister();
    resolveHook = undefined;
  };

  let preparing: Promise<PreparedHost> | undefined;
  const prepare = (ctx: ServiceContext): Promise<PreparedHost> => {
    preparing ??= (async (): Promise<PreparedHost> => {
      // Before anything can load extension code: plugins loaded from outside the
      // platform root get the host's copy of the platform packages (ADR-0048 D5).
      // If anything below refuses to start, no module teardown ever runs to remove
      // it, so it is removed here instead — otherwise a later host in the same
      // process (as in tests) could never install its own.
      resolveHook = installPlatformResolveHook({
        platformRoot: ctx.platformRoot,
        anchors: options.moduleUrl ? [options.moduleUrl] : [],
        logger: ctx.logger.forComponent("platform-resolve"),
      });
      try {
        if (process.env.KB_SOCKET_PATH) {
          // getListenOptions() would bind every module to the same socket path.
          throw new Error(
            "KB_SOCKET_PATH is set: the host runs several modules in one process and cannot share one socket path between them. Unset it.",
          );
        }
        const gatewayConfigRoot = resolveGatewayConfigRoot(ctx, GATEWAY_CONFIG_SCOPE);
        const effective = await loadEffectiveConfig({
          platformRoot: ctx.platformRoot,
        });
        const platformConfig = (effective?.data as { platform?: unknown } | undefined)?.platform;
        if (platformConfig && typeof platformConfig === "object" && !Array.isArray(platformConfig)) {
          const issues = await validatePlatformAdapterOptions(gatewayConfigRoot, platformConfig as Record<string, unknown>);
          const issue = issues[0];
          if (issue) {
            throw new AdapterConfigError(issue.path, issue.message, issue.hint ?? "Correct the adapter option and run `kb-create start` again.");
          }
        }
        const settings = parseHostSettings(
          (effective?.data as { host?: unknown } | undefined)?.host,
        );
        const upstreams = generatedUpstreams(settings);
        let gatewayAddress: string | undefined;
        if (isSelected(settings, "gateway")) {
          const gatewayConfig = await loadGatewayConfig(ctx.platformRoot);
          // Dry run: refuse an unsafe exposure before any module binds a port.
          applyHostGatewayPolicy(
            gatewayConfig,
            { auth: settings.auth, upstreams },
          );
          const listenAddress = resolveServiceListenAddress(
            ctx.platform.getAdapter<IServiceTransport>("serviceTransport"),
            {
              serviceId: GATEWAY_SERVICE_NETWORK.serviceId,
              portEnvVar: GATEWAY_SERVICE_NETWORK.portEnvVar,
              portEnvValue: process.env[GATEWAY_SERVICE_NETWORK.portEnvVar],
              hostEnvValue: process.env[GATEWAY_SERVICE_NETWORK.hostEnvVar],
              defaultPort: GATEWAY_SERVICE_NETWORK.defaultPort,
              defaultHost: GATEWAY_SERVICE_NETWORK.defaultHost,
            },
            ctx.netOffset,
          );
          gatewayAddress = `http://${INTERNAL_BIND_HOST}:${listenAddress.port}`;
        }
        const platformDataRoot = await resolvePlatformDataRoot(ctx.platformRoot);
        return { settings, upstreams, platformDataRoot, gatewayAddress };
      } catch (error) {
        releaseResolveHook();
        throw error;
      }
    })();
    return preparing;
  };

  const releaseHookBeforeTeardown = (teardown: Teardown): Teardown => async () => {
    releaseResolveHook();
    await teardown();
  };
  const skipped = async (): Promise<Teardown> => releaseHookBeforeTeardown(async () => {});

  const internal = INTERNAL_MODULES.map((spec) =>
    defineHostModule({
      id: spec.id,
      serviceId: spec.serviceId,
      // Internal modules never bind beyond loopback; no host env override.
      defaultHost: INTERNAL_BIND_HOST,
      defaultPort: 0,
      setup: async (ctx) => {
        const { settings, platformDataRoot } = await prepare(ctx);
        try {
          const teardown = await (async (): Promise<Teardown> => {
            if (!isSelected(settings, spec.id)) {
              ctx.logger.info("Module disabled by host.modules", {
                moduleId: spec.id,
              });
              return skipped();
            }
            const teardown = await spec.setup({ ...ctx, logger: ctx.logger.forComponent(spec.id) }, platformDataRoot);
            assertInternalAddress(ctx, spec.serviceId, generated);
            return teardown;
          })();
          return releaseHookBeforeTeardown(teardown);
        } catch (error) {
          releaseResolveHook();
          throw error;
        }
      },
    }),
  );

  const gateway: HostModule = defineHostModule({
    ...GATEWAY_SERVICE_NETWORK,
    id: GATEWAY_SERVICE_NETWORK.serviceId,
    setup: async (ctx) => {
      const { settings, upstreams, gatewayAddress } = await prepare(ctx);
      if (!isSelected(settings, "gateway")) {
        ctx.logger.info("Module disabled by host.modules", {
          moduleId: "gateway",
        });
        return skipped();
      }
      const logger = ctx.logger.forComponent("project-runtime");
      const registry = options.projectRegistry ?? createProjectRegistry();
      const registryWrites = new Set<Promise<void>>();
      const overrides = options.projectRuntime ?? {};
      const launcher =
        overrides.launcher ??
        createChildProcessLauncher({
          entry: overrides.entry ?? defaultRuntimeEntry(),
          // One platform per machine: every project runtime runs on the host's.
          env: {
            KB_PLATFORM_ROOT: ctx.platformRoot,
            KB_MCP_AUTH_MODE: settings.auth === "off" ? "local" : "secured",
            KB_STATE_DAEMON_URL: stateDaemonUrl!,
            KB_GATEWAY_URL: gatewayAddress,
          },
          ...(overrides.stopTimeoutMs !== undefined
            ? { stopTimeoutMs: overrides.stopTimeoutMs }
            : {}),
        });
      const fingerprintDiscoveryObservations = ctx.runtime.catalog.discoveryObservationFingerprinter();
      const manager = new ProjectRuntimeManager({
        launcher,
        logger,
        maxActiveProjects: settings.maxActiveProjects,
        idleTimeoutMs:
          overrides.idleTimeoutMs ?? settings.projectIdleTimeoutSec * 1000,
        startTimeoutMs:
          overrides.startTimeoutMs ?? settings.projectStartTimeoutSec * 1000,
        ...(overrides.startPollMs !== undefined
          ? { startPollMs: overrides.startPollMs }
          : {}),
        ...(overrides.healthIntervalMs !== undefined
          ? { healthIntervalMs: overrides.healthIntervalMs }
          : {}),
        ...(overrides.healthFailureThreshold !== undefined
          ? { healthFailureThreshold: overrides.healthFailureThreshold }
          : {}),
        ...(overrides.sweepIntervalMs !== undefined
          ? { sweepIntervalMs: overrides.sweepIntervalMs }
          : {}),
        ...(overrides.restart ? { restart: overrides.restart } : {}),
        getPluginSetDigest: (project) => fingerprintDiscoveryObservations([ctx.platformRoot, project.root]),
        onStarted: (project) => {
          const write = registry.touch(project.id)
            .then(() => undefined)
            .catch((error: unknown) => {
              logger.warn("Could not record project use", {
                projectId: project.id,
                error: error instanceof Error ? error.message : String(error),
              });
            })
            .finally(() => registryWrites.delete(write));
          registryWrites.add(write);
        },
      });
      const hostControlCredential = process.env[catalogEnvironmentVariables.KB_HOST_CONTROL_TOKEN];
      const activeWorkControl = hostControlCredential
        ? await startHostActiveWorkControl(hostControlCredential, ctx.activeWork, manager)
        : undefined;
      const refreshScheduledProjects = async (): Promise<void> => {
        const scheduled = await findScheduledProjects(registry);
        await manager.syncScheduledProjects(scheduled);
      };
      await refreshScheduledProjects();
      const scheduleRefreshTimer = setInterval(() => {
        void refreshScheduledProjects().catch((error: unknown) => {
          logger.warn("Could not refresh scheduled workflow runtime leases", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, 30_000);
      scheduleRefreshTimer.unref();

      // The marketplace module (if selected) already started listening above
      // (internal modules run before "gateway" in `modules`); reach it on its
      // internal loopback address so `/api/v1/plugins` never opens a second
      // writer of `.kb/marketplace.lock`.
      const marketplaceBaseUrl = isSelected(settings, "marketplace")
        ? internalBaseUrl(generated, "marketplace")
        : undefined;
      const pluginsRoutes = marketplaceBaseUrl
        ? [createPluginsRoutes({ registry, marketplace: new MarketplaceClient(marketplaceBaseUrl) })]
        : [];
      if (isSelected(settings, "marketplace") && !marketplaceBaseUrl) {
        ctx.logger.warn(
          "Marketplace module selected but has no internal address; /api/v1/plugins will not be mounted",
        );
      }

      const projectRouting = createProjectRouting({ registry, manager, logger });
      const stopGateway = await startGateway(
        { ...ctx, logger: ctx.logger.forComponent("gateway") },
        {
          configScope: GATEWAY_CONFIG_SCOPE,
          configure: (config) =>
            applyHostGatewayPolicy(
              { ...config, studio: config.studio ?? { enabled: true } },
              { auth: settings.auth, upstreams },
            ),
          projectRouting,
          projectServices: PROJECT_SERVICE_DECLARATIONS,
          projectServiceTransport: createProjectServiceTransport(projectRouting),
          hostRoutes: combineHostRoutes(
            createProjectsRoutes({ registry, manager }),
            ...pluginsRoutes,
          ),
          ...(activeWorkControl ? { readinessControlAddress: activeWorkControl.address } : {}),
        },
      );
      return releaseHookBeforeTeardown(async () => {
        clearInterval(scheduleRefreshTimer);
        // Stop taking requests first, then stop the runtimes they were for.
        try {
          await stopGateway();
        } finally {
          try {
            await activeWorkControl?.close();
          } finally {
            await manager.stopAll();
            await Promise.all(registryWrites);
          }
        }
      });
    },
  });

  return {
    appId: HOST_APP_ID,
    projectScope: "platform",
    startDir: options.startDir,
    moduleUrl: options.moduleUrl,
    platform: {
      assemblyHook,
      hostServiceEnvironment,
    },
    // Gateway last: it starts once its upstreams are listening and, torn down
    // in reverse order, stops accepting traffic first.
    modules: [...internal, gateway],
    publishListenAddress: async (module, address) => {
      const serviceId = module.serviceId ?? module.id;
      await generated.publishListenAddress(serviceId, address);
      if (serviceId === "state-daemon") {
        stateDaemonUrl = `http://${address.host}:${address.port}`;
        hostServiceEnvironment.KB_STATE_DAEMON_URL = stateDaemonUrl;
      }
    },
  };
}

/** Launches the platform once and runs the selected modules until a signal. */
export async function startHost(options: HostOptions = {}): Promise<void> {
  await runHost(await createHostConfig(options));
}
