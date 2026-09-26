/**
 * @module @kb-labs/host-app/host
 *
 * The machine-level host: ONE process, ONE platform launch, ONE external port.
 *
 * It composes the gateway, the marketplace service and the state daemon as
 * {@link HostModule}s of `runHost`. Only the gateway listens on a public
 * address (`gateway.port + KB_NET_OFFSET`); marketplace and state bind
 * ephemeral loopback ports that the host resolves itself and injects in-process
 * into the gateway's service transport, so no module addresses are written in
 * config. See ADR-0043 and docs/architecture/target/04-topology.md.
 */

import { loadEffectiveConfig } from "@kb-labs/core-config";
import type { IServiceTransport } from "@kb-labs/core-platform";
import type { PlatformAssemblyHook } from "@kb-labs/core-runtime";
import {
  isLoopbackHost,
  loadGatewayConfig,
  startGateway,
} from "@kb-labs/gateway-app";
import { setup as setupMarketplace } from "@kb-labs/marketplace-app";
import { setup as setupState } from "@kb-labs/core-state-daemon";
import { makeAssemblyHook } from "@kb-labs/plugin-runtime";
import {
  defineHostModule,
  runHost,
  type HostConfig,
  type HostModule,
  type ServiceContext,
} from "@kb-labs/shared-daemon";
import { applyHostGatewayPolicy, type GatewayUpstreams } from "./policy.js";
import {
  parseHostSettings,
  type HostModuleId,
  type HostSettings,
} from "./settings.js";
import {
  createGeneratedTransport,
  HostServiceTransport,
  INTERNAL_BIND_HOST,
  reserveLoopbackPorts,
} from "./transport.js";

export const HOST_APP_ID = "kb-host";

type Teardown = () => Promise<void>;

interface InternalModuleSpec {
  id: Exclude<HostModuleId, "gateway">;
  /** Key in the service transport map; what the gateway upstream points at. */
  serviceId: string;
  upstreamName: string;
  prefix: string;
  rewritePrefix?: string;
  /** Legacy well-known port, only used if the transport does not know the id. */
  legacyPort: number;
  portEnvVar: string;
  setup: (ctx: ServiceContext) => Promise<Teardown>;
}

const INTERNAL_MODULES: readonly InternalModuleSpec[] = [
  {
    id: "marketplace",
    serviceId: "marketplace",
    upstreamName: "marketplace",
    prefix: "/api/v1/marketplace",
    legacyPort: 5070,
    portEnvVar: "KB_MARKETPLACE_PORT",
    setup: setupMarketplace,
  },
  {
    id: "state",
    serviceId: "state-daemon",
    upstreamName: "state",
    prefix: "/api/v1/state",
    // The state daemon serves /state/* and /health at its root.
    rewritePrefix: "",
    legacyPort: 7777,
    portEnvVar: "KB_STATE_DAEMON_PORT",
    setup: setupState,
  },
];

/** What the first module to start resolves once, for every module. */
interface PreparedHost {
  settings: HostSettings;
  upstreams: GatewayUpstreams;
}

function isSelected(settings: HostSettings, id: HostModuleId): boolean {
  return settings.modules.includes(id);
}

/**
 * An internal module must bind the loopback port the host's transport gave it.
 * If the transport does not know the service, runHost falls back to the
 * well-known default port (e.g. 5070/7777), which could collide with another
 * platform on the machine: refuse instead of binding it.
 */
function assertInternalAddress(ctx: ServiceContext, serviceId: string): void {
  const address = ctx.platform
    .getAdapter<IServiceTransport>("serviceTransport")
    ?.listenAddress?.(serviceId);
  if (!address || !("port" in address) || address.port !== ctx.port) {
    throw new Error(
      `The host service transport has no TCP address for "${serviceId}"; refusing to bind a well-known port.`,
    );
  }
  if (!isLoopbackHost(ctx.host)) {
    throw new Error(
      `Internal module "${serviceId}" would bind "${ctx.host}"; internal modules bind loopback only.`,
    );
  }
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

export interface HostOptions {
  /** Starting directory for project/platform root resolution. */
  startDir?: string;
  /** Entrypoint import.meta.url for installed-mode platform discovery. */
  moduleUrl?: string;
}

/**
 * Builds the `runHost` configuration. Async because the internal loopback
 * ports are reserved before the platform is launched (the transport must exist
 * when adapters are assembled, so that every module resolves its address from
 * it). Each call returns an independent host: nothing here is module-global.
 */
export async function createHostConfig(
  options: HostOptions = {},
): Promise<HostConfig> {
  const ports = await reserveLoopbackPorts(INTERNAL_MODULES.length);
  const generated = createGeneratedTransport(
    Object.fromEntries(
      INTERNAL_MODULES.map((spec, index) => [spec.serviceId, ports[index]!]),
    ),
  );

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

  let preparing: Promise<PreparedHost> | undefined;
  const prepare = (ctx: ServiceContext): Promise<PreparedHost> => {
    preparing ??= (async (): Promise<PreparedHost> => {
      if (process.env.KB_SOCKET_PATH) {
        // getListenOptions() would bind every module to the same socket path.
        throw new Error(
          "KB_SOCKET_PATH is set: the host runs several modules in one process and cannot share one socket path between them. Unset it.",
        );
      }
      const effective = await loadEffectiveConfig(ctx.projectRoot, {
        platformRoot: ctx.platformRoot,
      });
      const settings = parseHostSettings(
        (effective?.data as { host?: unknown } | undefined)?.host,
      );
      const upstreams = generatedUpstreams(settings);
      if (isSelected(settings, "gateway")) {
        // Dry run: refuse an unsafe exposure before any module binds a port.
        applyHostGatewayPolicy(
          await loadGatewayConfig(ctx.projectRoot, ctx.platformRoot),
          { auth: settings.auth, upstreams },
        );
      }
      return { settings, upstreams };
    })();
    return preparing;
  };

  const skipped = async (): Promise<Teardown> => async () => {};

  const internal = INTERNAL_MODULES.map((spec) =>
    defineHostModule({
      id: spec.id,
      serviceId: spec.serviceId,
      defaultPort: spec.legacyPort,
      portEnvVar: spec.portEnvVar,
      // Internal modules never bind beyond loopback; no host env override.
      defaultHost: INTERNAL_BIND_HOST,
      setup: async (ctx) => {
        const { settings } = await prepare(ctx);
        if (!isSelected(settings, spec.id)) {
          ctx.logger.info("Module disabled by host.modules", {
            moduleId: spec.id,
          });
          return skipped();
        }
        assertInternalAddress(ctx, spec.serviceId);
        return spec.setup({ ...ctx, logger: ctx.logger.forComponent(spec.id) });
      },
    }),
  );

  const gateway: HostModule = defineHostModule({
    id: "gateway",
    defaultPort: 4000,
    portEnvVar: "GATEWAY_PORT",
    defaultHost: "0.0.0.0",
    hostEnvVar: "GATEWAY_HOST",
    setup: async (ctx) => {
      const { settings, upstreams } = await prepare(ctx);
      if (!isSelected(settings, "gateway")) {
        ctx.logger.info("Module disabled by host.modules", {
          moduleId: "gateway",
        });
        return skipped();
      }
      return startGateway(
        { ...ctx, logger: ctx.logger.forComponent("gateway") },
        {
          configure: (config) =>
            applyHostGatewayPolicy(config, { auth: settings.auth, upstreams }),
        },
      );
    },
  });

  return {
    appId: HOST_APP_ID,
    startDir: options.startDir,
    moduleUrl: options.moduleUrl,
    platform: { assemblyHook },
    // Gateway last: it starts once its upstreams are listening and, torn down
    // in reverse order, stops accepting traffic first.
    modules: [...internal, gateway],
  };
}

/** Launches the platform once and runs the selected modules until a signal. */
export async function startHost(options: HostOptions = {}): Promise<void> {
  await runHost(await createHostConfig(options));
}
