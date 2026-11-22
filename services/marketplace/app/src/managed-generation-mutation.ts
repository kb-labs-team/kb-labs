import { readKbConfig, type MarketplaceSourcesConfig } from "@kb-labs/core-config";
import { NoOpLogger } from "@kb-labs/core-platform/noop";
import { MarketplaceService } from "@kb-labs/marketplace-core";
import { NpmPackageSource, RegistryPackageSource } from "@kb-labs/marketplace-npm";
import { parseManagedGenerationMutation } from "./managed-generation-request.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function assertManagedCandidateRoots(platformRoot: string, configRoot: string, processWorkingDirectory = process.cwd()): Promise<void> {
  const candidate = path.resolve(platformRoot);
  if (!path.basename(candidate).startsWith(".stage-managed-") || path.basename(path.dirname(candidate)) !== "versions") {
    throw new Error("managed Marketplace writes require a managed candidate generation");
  }
  for (const directory of [path.dirname(path.dirname(candidate)), path.dirname(candidate), candidate]) {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("managed Marketplace generation parents must be real directories");
  }
  const resolvedCandidate = await fs.realpath(candidate);
  if (resolvedCandidate !== candidate || path.resolve(processWorkingDirectory) !== resolvedCandidate) throw new Error("managed Marketplace candidate root does not match the process working directory");
  const installRoot = path.dirname(path.dirname(candidate));
  const currentPath = path.join(installRoot, "current");
  const currentStat = await fs.lstat(currentPath);
  if (!currentStat.isSymbolicLink()) throw new Error("managed Marketplace install has no current generation link");
  const active = await fs.realpath(currentPath);
  if (active === resolvedCandidate || path.dirname(active) !== path.dirname(candidate) || path.basename(active).startsWith(".stage-managed-")) {
    throw new Error("managed Marketplace candidate must not be the active generation");
  }
  if (await fs.realpath(configRoot) !== active) throw new Error("managed Marketplace config root must be the active generation");
  const candidateReceipt = JSON.parse(await fs.readFile(path.join(candidate, ".kb", "v2", "receipt.json"), "utf8")) as { installationId?: unknown };
  const activeReceipt = JSON.parse(await fs.readFile(path.join(active, ".kb", "v2", "receipt.json"), "utf8")) as { installationId?: unknown };
  if (typeof candidateReceipt.installationId !== "string" || candidateReceipt.installationId !== activeReceipt.installationId) {
    throw new Error("managed Marketplace candidate does not belong to the active installation");
  }
}

export async function runManagedGenerationMutation(): Promise<void> {
  const platformRoot = process.env.KB_PLATFORM_ROOT;
  const configRoot = process.env.KB_MARKETPLACE_CONFIG_ROOT;
  if (!platformRoot || !configRoot || !process.env.KB_HOME) throw new Error("managed Marketplace roots are not configured by the installer");
  await assertManagedCandidateRoots(platformRoot, configRoot);
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
  for (const spec of request.specs) {
    let primaryKind: string | undefined;
    let resolved = false;
    for (const source of sources) {
      const candidate = await source.resolveIdentity(spec);
      if (candidate.status === "not-found-unowned") continue;
      resolved = true;
      if (candidate.status === "found") primaryKind = candidate.package.primaryKind;
      break;
    }
    if (!resolved || primaryKind === undefined) throw new Error("managed adapter package is not present in configured sources");
    if (primaryKind !== "adapter") throw new Error("managed generation install accepts adapter packages only");
  }
  const result = await service.install(scope, request.specs, { dev: request.dev });
  if (result.installed.length !== request.specs.length || result.installed.some(item => item.primaryKind !== "adapter" || item.scope !== "platform")) {
    throw new Error("Marketplace helper did not install every requested platform adapter");
  }
  const installed = [];
  for (const item of result.installed) {
    const resolvedPackageRoot = await fs.realpath(item.packageRoot);
    const resolvedStage = await fs.realpath(platformRoot);
    const relative = path.relative(resolvedStage, resolvedPackageRoot);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("installed adapter package escaped the candidate generation");
    installed.push({ packageId: item.id, version: item.version, primaryKind: item.primaryKind });
  }
  process.stdout.write(JSON.stringify({ schema: 1, operation: "install", installed }) + "\n");
}
