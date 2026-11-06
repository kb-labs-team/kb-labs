#!/usr/bin/env node
import { makeAssemblyHook } from "@kb-labs/plugin-runtime";
import { requireEnvironmentSecret, runService } from "@kb-labs/shared-daemon";
import { getListenOptions } from "@kb-labs/shared-http";
import { RegistryService } from "@kb-labs/marketplace-registry-core";
import { createRegistryServer } from "@kb-labs/marketplace-registry-api";

async function main(): Promise<void> {
  await runService({
    appId: "marketplace-registry",
    projectScope: "platform",
    defaultPort: 5071,
    portEnvVar: "KB_REGISTRY_PORT",
    // The registry API is an internal Gateway upstream, not an internet edge.
    defaultHost: "127.0.0.1",
    hostEnvVar: "KB_REGISTRY_HOST",
    platform: {
      assemblyHook: makeAssemblyHook(),
    },
    async setup({ platform, logger, port, host, platformRoot }) {
      void platformRoot; // reserved for future per-project scoping

      const service = new RegistryService({
        storage: platform.storage,
        cache: platform.cache,
        logger: platform.logger,
        baseUrl: process.env.KB_REGISTRY_URL ?? `http://localhost:${port}`,
        signingPrivateKey: process.env.KB_REGISTRY_SIGNING_KEY,
        siteUrl: process.env.KB_SITE_URL ?? "https://kblabs.ru",
      });

      const internalSecret = requireEnvironmentSecret("GATEWAY_INTERNAL_SECRET");

      const server = await createRegistryServer({
        port,
        host,
        logger: platform.logger,
        registry: service,
        internalSecret,
      });
      await server.listen(getListenOptions(port, host));

      // Note: actual binding may be via Unix socket (KB_SOCKET_PATH) — see getListenOptions()

      return async () => {
        await server.close();
      };
    },
  });
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exitCode = 1;
});
