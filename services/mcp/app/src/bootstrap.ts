import { makeAssemblyHook } from "@kb-labs/plugin-runtime";
import { resolvePolicy } from "@kb-labs/core-policy";
import { noopUI } from "@kb-labs/plugin-contracts";
import { runService } from "@kb-labs/shared-daemon";
import { loadJwtConfig } from "./mcp/auth.js";
import { callOutput } from "./mcp/output-capture.js";
import { createBufferedUI } from "./mcp/ui.js";
import { McpDaemonServer } from "./server.js";

export async function bootstrap(): Promise<void> {
  await runService({
    appId: "mcp-daemon",
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
        const lines = callOutput.getStore();
        return lines ? createBufferedUI((s) => lines.push(s)).ui : noopUI;
      },
      assemblyHook: makeAssemblyHook(),
    },
    async setup({
      platform,
      logger: serviceLogger,
      port,
      host,
      projectRoot,
      platformRoot,
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
        platform,
        resolvePlatform: () => platform,
        projectRoot,
        platformRoot,
        jwtConfig: loadJwtConfig(),
        policy,
        developmentPdpStub: process.env.NODE_ENV !== 'production'
          && process.env.KB_MCP_AGENT_LEASE_PDP_STUB === 'allow-all',
      });

      await server.start();

      return async () => {
        await server.stop();
      };
    },
  });
}
