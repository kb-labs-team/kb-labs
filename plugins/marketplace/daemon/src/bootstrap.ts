/**
 * @module @kb-labs/marketplace-app/bootstrap
 * Server bootstrap: runService → PlatformRuntime → MarketplaceService → Fastify server.
 */

import { makeAssemblyHook } from "@kb-labs/plugin-runtime";
import { getListenOptions } from "@kb-labs/shared-http";
import { runService, type ServiceContext } from "@kb-labs/shared-daemon";
import { readKbConfig } from "@kb-labs/core-config";
import { createServer } from "@kb-labs/marketplace-api";
import { MarketplaceService } from "@kb-labs/marketplace-core";
import {
  NpmPackageSource,
  RegistryPackageSource,
} from "@kb-labs/marketplace-npm";

/**
 * Marketplace service body. Importable and side-effect-free: it only starts
 * work when called with a resolved {@link ServiceContext}.
 */
export async function setup({
  logger,
  port,
  host,
  projectRoot,
  platformRoot,
}: ServiceContext): Promise<() => Promise<void>> {
  const repoRoot = projectRoot;

  // Read marketplace.registry config to wire up RegistryPackageSource for kb: specs.
  const kbConfig = await readKbConfig(repoRoot);
  const registryConfig = (
    kbConfig?.data as Record<string, unknown> | undefined
  )?.marketplace as Record<string, unknown> | undefined;
  const registryUrl =
    ((registryConfig?.registry as Record<string, unknown> | undefined)
      ?.url as string | undefined) ?? process.env.KB_REGISTRY_URL;

  const registrySource = registryUrl
    ? new RegistryPackageSource({
        registryUrl,
        authToken: process.env.KB_REGISTRY_TOKEN,
      })
    : undefined;

  const service = new MarketplaceService({
    platformRoot,
    source: new NpmPackageSource(),
    registrySource,
  });

  const server = await createServer({ service, port, logger });
  await server.listen(getListenOptions(port, host));

  logger.info(`Marketplace service listening on http://${host}:${port}`);
  logger.info(`OpenAPI docs: http://localhost:${port}/docs`);

  return async () => {
    await server.close();
  };
}

export async function bootstrap(_cwd: string = process.cwd()): Promise<void> {
  await runService({
    appId: "marketplace",
    startDir: _cwd,
    defaultPort: 5070,
    portEnvVar: "KB_MARKETPLACE_PORT",
    // Defaults to 0.0.0.0 for Docker/dev compat. Set KB_MARKETPLACE_HOST=127.0.0.1 to restrict to loopback.
    defaultHost: "0.0.0.0",
    hostEnvVar: "KB_MARKETPLACE_HOST",
    platform: {
      assemblyHook: makeAssemblyHook(),
    },
    setup,
  });
}
