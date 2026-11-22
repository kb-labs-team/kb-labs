/**
 * @module @kb-labs/marketplace-app/bootstrap
 * Server bootstrap: runService → PlatformRuntime → MarketplaceService → Fastify server.
 */

import { makeAssemblyHook } from "@kb-labs/plugin-runtime";
import { getListenOptions } from "@kb-labs/shared-http";
import { requireEnvironmentSecret, runService, type ServiceContext } from "@kb-labs/shared-daemon";
import { readKbConfig, type MarketplaceSourcesConfig } from "@kb-labs/core-config";
import { createErrorEnvelope, ErrorEnvelopeError } from "@kb-labs/core-platform/error-envelope";
import { createServer } from "@kb-labs/marketplace-api";
import { MarketplaceService } from "@kb-labs/marketplace-core";
import { createExtensionStore } from "@kb-labs/core-extension-store";
import {
  NpmPackageSource,
  RegistryPackageSource,
} from "@kb-labs/marketplace-npm";
import { createManagedPlatformInstallDispatcher, isManagedPlatformRoot } from "./managed-marketplace-owner.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

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
  const configData = kbConfig?.data as {
    gateway?: { access?: { mode?: string }; auth?: { enabled?: boolean } };
    platform?: { deployment?: { topology?: string } };
  } | undefined;
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

  const internalSecret = requireEnvironmentSecret("GATEWAY_INTERNAL_SECRET");

  const service = new MarketplaceService({
    platformRoot,
    logger,
    extensionStore: createExtensionStore({ platformRoot }),
    sources,
    resolveSelectedAdapterSlot: async (packageId) => {
      const currentConfig = await readKbConfig(repoRoot);
      const data = isRecord(currentConfig?.data) ? currentConfig.data : {};
      const platform = isRecord(data.platform) ? data.platform : {};
      const adapters = isRecord(platform.adapters) ? platform.adapters : {};
      for (const [slot, binding] of Object.entries(adapters)) {
        if (binding === packageId || (Array.isArray(binding) && binding.includes(packageId))) {
          return slot;
        }
      }
      return null;
    },
  });

  const projectScopeAllowed = configData?.gateway?.access?.mode === 'local'
    && configData.gateway.auth?.enabled !== true
    && configData.platform?.deployment?.topology === 'local';
  const managedPlatform = (typeof process.env.KB_INSTALLATION_ID === 'string' && process.env.KB_INSTALLATION_ID.length > 0)
    || await isManagedPlatformRoot(platformRoot);
  const dispatchManagedPlatformInstall = managedPlatform
    ? createManagedPlatformInstallDispatcher({
      ownerBinary: process.env.KB_CREATE_OWNER_BINARY,
      platformRoot,
    })
    : undefined;
  const server = await createServer({
    service,
    port,
    logger,
    auth: {
      internalSecret,
      projectScopeAllowed,
      managedPlatform,
      ...(dispatchManagedPlatformInstall ? { dispatchManagedPlatformInstall } : {}),
    },
  });
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
