import { readKbConfig, type MarketplaceSourcesConfig } from "@kb-labs/core-config";
import { NoOpLogger } from "@kb-labs/core-platform/noop";
import { MarketplaceService } from "@kb-labs/marketplace-core";
import { createExtensionStore } from "@kb-labs/core-extension-store";
import { NpmPackageSource, RegistryPackageSource } from "@kb-labs/marketplace-npm";
import { parseManagedGenerationMutation } from "./managed-generation-request.js";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function runManagedGenerationMutation(): Promise<void> {
  const platformRoot = process.env.KB_PLATFORM_ROOT;
  const configRoot = process.env.KB_MARKETPLACE_CONFIG_ROOT;
  if (!platformRoot || !configRoot || !process.env.KB_HOME) throw new Error("managed Marketplace roots are not configured by the installer");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 64 * 1024) throw new Error("managed Marketplace request exceeds size limit");
    chunks.push(bytes);
  }
  const request = parseManagedGenerationMutation(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
  const config = await readKbConfig(configRoot, { required: true });
  const marketplace = (config?.data as { marketplace?: { sources?: MarketplaceSourcesConfig } } | undefined)?.marketplace;
  const configured = marketplace?.sources;
  if (!configured?.[0]) throw new Error("marketplace.sources is not configured");
  const sources = [
    ...(configured[0].kind === "registry" ? [new RegistryPackageSource({ registryUrl: configured[0].url, signingPublicKey: configured[0].signingPublicKey, authToken: configured[0].authToken })] : []),
    ...configured.flatMap(source => source?.kind === "npm" ? [new NpmPackageSource({ registryUrl: source.url })] : []),
  ];
  const service = new MarketplaceService({
    platformRoot,
    logger: new NoOpLogger(),
    extensionStore: createExtensionStore({ platformRoot }),
    sources,
    resolveSelectedAdapterSlot: async packageId => {
      const current = await readKbConfig(configRoot);
      const data = record(current?.data) ? current.data : {};
      const platform = record(data.platform) ? data.platform : {};
      const adapters = record(platform.adapters) ? platform.adapters : {};
      for (const [slot, binding] of Object.entries(adapters)) if (binding === packageId || (Array.isArray(binding) && binding.includes(packageId))) return slot;
      return null;
    },
  });
  const scope = { scope: "platform" as const };
  switch (request.operation) {
    case "install": await service.install(scope, request.specs, { dev: request.dev }); break;
    case "uninstall": await service.uninstall(scope, request.packageIds); break;
    case "update": await service.update(scope, request.packageIds); break;
    case "enable": await service.enable(scope, request.packageId); break;
    case "disable": await service.disable(scope, request.packageId); break;
  }
  process.stdout.write(JSON.stringify({ ok: true }) + "\n");
}
