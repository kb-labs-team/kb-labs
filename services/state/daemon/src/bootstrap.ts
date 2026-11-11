import { makeAssemblyHook } from "@kb-labs/plugin-runtime";
import { runService, type ServiceContext } from "@kb-labs/shared-daemon";
import { createDurableStateDaemon, StateDaemonServer } from "./server.js";

/**
 * State daemon service body. Importable and side-effect-free: it only starts
 * work when called with a resolved {@link ServiceContext}.
 */
export async function setup({
  port,
  host,
  logger,
}: ServiceContext, platformDataRoot?: string): Promise<() => Promise<void>> {
  const config = {
    port,
    host,
    logger,
  };
  const server = platformDataRoot
    ? createDurableStateDaemon(config, platformDataRoot)
    : new StateDaemonServer(config);
  await server.start();
  return () => server.stop();
}

export async function bootstrap(_cwd: string = process.cwd()): Promise<void> {
  await runService({
    appId: "state-daemon",
    projectScope: "platform",
    startDir: _cwd,
    portEnvVar: "KB_STATE_DAEMON_PORT",
    defaultHost: "localhost",
    hostEnvVar: "KB_STATE_DAEMON_HOST",
    platform: {
      assemblyHook: makeAssemblyHook(),
    },
    setup,
  });
}
