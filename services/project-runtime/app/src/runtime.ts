/**
 * @module @kb-labs/project-runtime-app/runtime
 *
 * ONE process for ONE project. It launches the platform once (rooted at the
 * project) and composes the project-scoped services as `runHost` modules. The
 * modules bind ephemeral loopback ports chosen here; the only address the host
 * needs is the guard's `--listen` address. See ADR-0043 (model B) and
 * docs/architecture/target/04-topology.md.
 */

import { realpath } from "node:fs/promises";
import { HttpServiceTransport } from "@kb-labs/adapters-service-transport-http";
import type { IServiceTransport } from "@kb-labs/core-platform";
import type { PlatformAssemblyHook } from "@kb-labs/core-runtime";
import { makeAssemblyHook } from "@kb-labs/plugin-runtime";
import { setup as setupRest } from "@kb-labs/rest-api-app";
import {
  defineHostModule,
  LOOPBACK_HOST,
  reserveLoopbackPorts,
  type HostConfig,
  type HostModule,
  type ServiceContext,
} from "@kb-labs/shared-daemon";
import { setup as setupWorkflow } from "@kb-labs/workflow-daemon";
import type { RuntimeArgs } from "./args.js";
import { createRuntimeGuard } from "./guard.js";
import { RuntimeServiceTransport } from "./transport.js";

export const PROJECT_RUNTIME_APP_ID = "kb-project-runtime";

/** serviceId of the guard in the runtime's transport map. */
const GUARD_SERVICE_ID = "project-runtime";

type Teardown = () => Promise<void>;

/** One project-scoped service the runtime runs. */
export interface ProjectRuntimeModule {
  /** Path segment the guard routes on, e.g. `rest` for `/rest/...`. */
  id: string;
  /** Key in the service transport map; what other modules route to. */
  serviceId: string;
  setup: (ctx: ServiceContext) => Promise<Teardown>;
}

/** The project-scoped services that exist today. MCP is not composable yet. */
export const DEFAULT_PROJECT_MODULES: readonly ProjectRuntimeModule[] = [
  { id: "rest", serviceId: "rest", setup: setupRest },
  { id: "workflow", serviceId: "workflow", setup: setupWorkflow },
];

export interface ProjectRuntimeOptions
  extends Pick<
    RuntimeArgs,
    "projectRoot" | "projectId" | "listen" | "token"
  > {
  /** Defaults to {@link DEFAULT_PROJECT_MODULES}. */
  modules?: readonly ProjectRuntimeModule[];
  /** Entrypoint import.meta.url for installed-mode platform discovery. */
  moduleUrl?: string;
}

function loopbackUrl(port: number): string {
  return `http://${LOOPBACK_HOST}:${port}`;
}

/**
 * A module must bind the loopback port the runtime's transport gave it. If the
 * transport does not know the service, runHost falls back to a well-known
 * default port that another project's runtime may already hold: refuse instead.
 */
function assertModuleAddress(ctx: ServiceContext, serviceId: string): void {
  const address = ctx.platform
    .getAdapter<IServiceTransport>("serviceTransport")
    ?.listenAddress?.(serviceId);
  if (!address || !("port" in address) || address.port !== ctx.port) {
    throw new Error(
      `The project runtime transport has no TCP address for "${serviceId}"; refusing to bind a well-known port.`,
    );
  }
}

/** The platform must be rooted at the project this runtime was started for. */
async function assertProjectRoot(
  ctx: ServiceContext,
  expected: string,
): Promise<void> {
  const actual = await realpath(ctx.projectRoot);
  if (actual !== (await realpath(expected))) {
    throw new Error(
      `The platform resolved project root "${actual}" but this runtime serves "${expected}".`,
    );
  }
}

/**
 * Builds the `runHost` configuration of one project runtime. Async because the
 * module ports are reserved before the platform launches (the transport must
 * exist when adapters are assembled). Every call returns an independent
 * runtime: nothing here is module-global.
 */
export async function createProjectRuntimeConfig(
  options: ProjectRuntimeOptions,
): Promise<HostConfig> {
  if (process.env.KB_SOCKET_PATH) {
    // getListenOptions() would bind every module to the same socket path.
    throw new Error(
      "KB_SOCKET_PATH is set: a project runtime runs several modules in one process and cannot share one socket path between them. Unset it.",
    );
  }

  const modules = options.modules ?? DEFAULT_PROJECT_MODULES;
  const ports = await reserveLoopbackPorts(modules.length);
  const moduleAddresses = Object.fromEntries(
    modules.map((spec, index) => [
      spec.id,
      { host: LOOPBACK_HOST, port: ports[index]! },
    ]),
  );

  const services: Record<string, { url: string }> = {
    [GUARD_SERVICE_ID]: {
      url: `http://${options.listen.host}:${options.listen.port}`,
    },
  };
  modules.forEach((spec, index) => {
    services[spec.serviceId] = { url: loopbackUrl(ports[index]!) };
  });
  // offset 0: these are exact ports, not well-known ones to shift.
  const generated = new HttpServiceTransport({ services, offset: 0 });

  const baseHook = makeAssemblyHook();
  const assemblyHook: PlatformAssemblyHook = (platform, broker, config) => {
    const assembled = baseHook(platform, broker, config);
    const configured =
      platform.getAdapter<IServiceTransport>("serviceTransport");
    return {
      ...assembled,
      serviceTransport: new RuntimeServiceTransport(generated, configured),
    };
  };

  const serviceModules = modules.map((spec) =>
    defineHostModule({
      id: spec.id,
      serviceId: spec.serviceId,
      defaultPort: 0,
      portEnvVar: "KB_PROJECT_RUNTIME_UNUSED_PORT",
      // Project services never bind beyond loopback and take no env override.
      defaultHost: LOOPBACK_HOST,
      setup: async (ctx) => {
        await assertProjectRoot(ctx, options.projectRoot);
        assertModuleAddress(ctx, spec.serviceId);
        return spec.setup({ ...ctx, logger: ctx.logger.forComponent(spec.id) });
      },
    }),
  );

  // Last: it answers only once every module is listening, so a healthy guard
  // means a started runtime; torn down first, it stops accepting traffic first.
  const guard: HostModule = defineHostModule({
    id: "guard",
    serviceId: GUARD_SERVICE_ID,
    defaultPort: 0,
    portEnvVar: "KB_PROJECT_RUNTIME_UNUSED_PORT",
    defaultHost: options.listen.host,
    setup: async (ctx) => {
      assertModuleAddress(ctx, GUARD_SERVICE_ID);
      const server = createRuntimeGuard({
        token: options.token,
        projectId: options.projectId,
        projectRoot: options.projectRoot,
        modules: moduleAddresses,
        logger: ctx.logger.forComponent("guard"),
      });
      await server.listen({ host: ctx.host, port: ctx.port });
      return () => server.close();
    },
  });

  return {
    appId: PROJECT_RUNTIME_APP_ID,
    startDir: options.projectRoot,
    moduleUrl: options.moduleUrl,
    platform: { assemblyHook },
    modules: [...serviceModules, guard],
  };
}
