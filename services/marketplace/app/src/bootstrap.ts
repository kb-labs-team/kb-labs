/**
 * @module @kb-labs/marketplace-app/bootstrap
 * Server bootstrap: runService → PlatformRuntime → MarketplaceService → Fastify server.
 */

import { makeAssemblyHook } from "@kb-labs/plugin-runtime";
import { getListenOptions } from "@kb-labs/shared-http";
import { runService, type ServiceContext } from "@kb-labs/shared-daemon";
import { readKbConfig, type MarketplaceSourcesConfig } from "@kb-labs/core-config";
import { createErrorEnvelope, ErrorEnvelopeError } from "@kb-labs/core-platform/error-envelope";
import { createServer } from "@kb-labs/marketplace-api";
import { MarketplaceService } from "@kb-labs/marketplace-core";
import { createExtensionStore } from "@kb-labs/core-extension-store";
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
  platformRoot,
}: ServiceContext): Promise<() => Promise<void>> {
  const repoRoot = platformRoot;

  const kbConfig = await readKbConfig(repoRoot, { required: true });
  const marketplace = (kbConfig?.data as { marketplace?: { sources?: MarketplaceSourcesConfig } } | undefined)?.marketplace;
  const sourcesConfig = marketplace?.sources;
  if (!sourcesConfig?.[0]) {
    throw new ErrorEnvelopeError(createErrorEnvelope('KB_CONFIG_INVALID', { details: { path: 'marketplace.sources' } }));
  }
  const sources = [
    ...(sourcesConfig[0].kind === 'registry'
      ? [new RegistryPackageSource({
        registryUrl: sourcesConfig[0].url,
        signingPublicKey: sourcesConfig[0].signingPublicKey,
        authToken: sourcesConfig[0].authToken,
      })]
      : []),
    ...sourcesConfig.flatMap(source => source?.kind === 'npm'
      ? [new NpmPackageSource({ registryUrl: source.url })]
      : []),
  ];

  const service = new MarketplaceService({
    platformRoot,
    logger,
    extensionStore: createExtensionStore({ platformRoot }),
    sources,
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
    projectScope: "platform",
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
