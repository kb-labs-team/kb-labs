import { makeAssemblyHook } from "@kb-labs/plugin-runtime";
import { resolvePolicy } from "@kb-labs/core-policy";
import { noopUI } from "@kb-labs/plugin-contracts";
import { requireProjectContext } from "@kb-labs/core-runtime";
import { runService } from "@kb-labs/shared-daemon";
import { callOutput } from "./mcp/output-capture.js";
import { createBufferedUI } from "./mcp/ui.js";
import { McpDaemonServer } from "./server.js";
import type { ServiceContext } from "@kb-labs/shared-daemon";
import type { IServiceTransport } from "@kb-labs/core-platform";
import type { ServiceManifest } from "@kb-labs/plugin-contracts";

/** Project-runtime module setup. The runtime supplies the project root and port,
 * so the MCP process scope follows the project URL selected by the host. */
export async function setupProjectMcp(ctx: ServiceContext, serviceManifests: readonly ServiceManifest[]): Promise<() => Promise<void>> {
  const logger = ctx.logger.forComponent("mcp");
  const { policy } = await resolvePolicy({});
  const authMode = process.env.KB_MCP_AUTH_MODE === "local" ? "local" : "secured";
  const server = new McpDaemonServer({
    port: ctx.port,
    host: ctx.host,
    logger,
    cache: ctx.platform.cache,
    catalog: ctx.runtime.catalog,
    platform: ctx.platform,
    resolvePlatform: () => ctx.platform,
    projectRoot: requireProjectContext(ctx.projectRoot),
    platformRoot: ctx.platformRoot,
    policy,
    endpointPath: "/",
    authMode,
    serviceManifests,
    serviceTransport: ctx.platform.getAdapter<IServiceTransport>("serviceTransport"),
  });
  const boundUrl = await server.start();
  const boundAddress = new URL(boundUrl);
  await ctx.publishListenAddress({ host: boundAddress.hostname, port: Number(boundAddress.port) });
  return async () => server.stop();
}

export async function bootstrap(): Promise<void> {
  await runService({
    appId: "mcp-daemon",
    projectScope: "required",
    defaultPort: 7779,
    portEnvVar: "KB_MCP_DAEMON_PORT",
    // 0.0.0.0 for Docker/dev compat, matching every other daemon in the
    // platform (marketplace-registry, marketplace, workflow, rest-api all
    // default here too). This used to be "localhost", which Fastify/Node
    // resolves via DNS — and on the Ubuntu-based E2E Docker image that
    // resolves to the IPv6 loopback ([::1]) only, not dual-stack. The
    // in-container health check (also on "localhost") happened to succeed
    // via ::1, masking the bug, while cross-container Playwright requests
    // hitting the published port over IPv4 got "socket hang up" — nothing
    // was listening on the IPv4 side. Set KB_MCP_DAEMON_HOST=127.0.0.1 to
    // restrict to loopback.
    defaultHost: "0.0.0.0",
    hostEnvVar: "KB_MCP_DAEMON_HOST",
    platform: {
      uiProvider: (_hostType: string) => {
        const output = callOutput.getStore();
        return output ? createBufferedUI((text, model) => {
          output.text.push(text);
          if (model) {output.structured.push(model);}
        }).ui : noopUI;
      },
      assemblyHook: makeAssemblyHook(),
    },
    async setup({
      platform,
      runtime,
      logger: serviceLogger,
      port,
      host,
      projectRoot,
      platformRoot,
      publishListenAddress,
    }) {
      const logger = serviceLogger
        .forComponent("mcp-bootstrap")
        .forOperation("mcp.bootstrap");

      logger.info("MCP daemon platform initialised");

      const { policy } = await resolvePolicy({});

      const server = new McpDaemonServer({
        port,
        host,
        logger,
        cache: platform.cache,
        catalog: runtime.catalog,
        platform,
        resolvePlatform: () => platform,
        projectRoot: requireProjectContext(projectRoot),
        platformRoot,
        policy,
      });

      const boundUrl = await server.start();
      const boundAddress = new URL(boundUrl);
      await publishListenAddress({ host: boundAddress.hostname, port: Number(boundAddress.port) });

      return async () => {
        await server.stop();
      };
    },
  });
}
