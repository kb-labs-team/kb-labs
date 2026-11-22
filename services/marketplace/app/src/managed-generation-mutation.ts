import { interpolateConfig, readRawKbConfig, type MarketplaceSourcesConfig } from "@kb-labs/core-config";
import { NoOpLogger } from "@kb-labs/core-platform/noop";
import { MarketplaceService } from "@kb-labs/marketplace-core";
import { NpmPackageSource, RegistryPackageSource } from "@kb-labs/marketplace-npm";
import { parseManagedGenerationMutation } from "./managed-generation-request.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function selectManagedAdapterUpdateIds(lock: unknown, requestedIds?: string[]): string[] {
  if (!record(lock) || !record(lock.adapters)) throw new Error("managed adapter update requires an existing adapter lock");
  const marketplaceAdapters = Object.entries(lock.adapters)
    .filter(([, entry]) => record(entry) && entry.source === "marketplace");
  const selected = requestedIds === undefined
    ? marketplaceAdapters.filter(([, entry]) => record(entry) && entry.marketplaceSource === "npm")
    : marketplaceAdapters.filter(([id]) => requestedIds.includes(id));
  const registryAdapter = selected.find(([, entry]) => record(entry) && entry.marketplaceSource !== "npm");
  if (registryAdapter) throw new Error(`managed adapter update currently supports npm-backed adapters only; ${registryAdapter[0]} uses ${String(record(registryAdapter[1]) ? registryAdapter[1].marketplaceSource : "unknown")}`);
  const marketplaceAdapterIds = marketplaceAdapters.map(([id]) => id);
  const ids = requestedIds ?? selected.map(([id]) => id);
  if (ids.length === 0 || ids.some(id => !marketplaceAdapterIds.includes(id))) {
    throw new Error("managed Marketplace update accepts only installed platform adapters");
  }
  return ids;
}

const requestSecretValues = new Set<string>();

export function serializeManagedGenerationFailure(error: unknown, sensitiveValues = [...requestSecretValues]): string {
  const value = record(error) ? error : {};
  const candidateCode = typeof value.code === "string" ? value.code : "";
  const code = /^[A-Z0-9_]{1,96}$/.test(candidateCode) ? candidateCode : "KB_MANAGED_MARKETPLACE_MUTATION_FAILED";
  let message = error instanceof Error ? error.message : "Managed Marketplace operation failed";
  let hint = typeof value.hint === "string" ? value.hint : "";
  for (const secret of [...sensitiveValues].sort((left, right) => right.length - left.length)) {
    message = message.replaceAll(secret, "[redacted]");
    hint = hint.replaceAll(secret, "[redacted]");
  }
  requestSecretValues.clear();
  return JSON.stringify({ schema: 1, code, message: message.slice(0, 2048), ...(hint ? { hint: hint.slice(0, 1024) } : {}) }) + "\n";
}

function referencedMarketplaceEnvironment(value: unknown): string[] {
  const names = new Set<string>();
  const sources = Array.isArray(value) ? value : [];
  for (const source of sources) {
    if (!record(source)) continue;
    for (const field of ["authToken", "signingPublicKey"] as const) {
      const setting = source[field];
      if (typeof setting !== "string") continue;
      for (const match of setting.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) names.add(match[1]!);
    }
  }
  return [...names].sort();
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

async function validateManagedArtifactCacheRoot(platformRoot: string, providedPath: string | undefined): Promise<string> {
  if (!providedPath) throw new Error("managed Marketplace artifact cache is not configured by the installer");
  const candidate = path.resolve(platformRoot);
  const installRoot = path.dirname(path.dirname(candidate));
  const stateRoot = path.join(installRoot, "state");
  const expected = path.join(stateRoot, "cache");
  const [stateInfo, cacheInfo] = await Promise.all([fs.lstat(stateRoot), fs.lstat(expected)]);
  if (!stateInfo.isDirectory() || stateInfo.isSymbolicLink() || !cacheInfo.isDirectory() || cacheInfo.isSymbolicLink()) {
    throw new Error("managed Marketplace artifact cache must be a physical install-owned directory");
  }
  const [providedReal, expectedReal] = await Promise.all([fs.realpath(providedPath), fs.realpath(expected)]);
  if (path.resolve(providedPath) !== providedReal || providedReal !== expectedReal) {
    throw new Error("managed Marketplace artifact cache reference does not match the installed cache");
  }
  return providedReal;
}

export async function runManagedGenerationMutation(): Promise<void> {
  const platformRoot = process.env.KB_PLATFORM_ROOT;
  const configRoot = process.env.KB_MARKETPLACE_CONFIG_ROOT;
  if (!platformRoot || !configRoot || !process.env.KB_HOME) throw new Error("managed Marketplace roots are not configured by the installer");
  await assertManagedCandidateRoots(platformRoot, configRoot);
  const artifactCacheRoot = await validateManagedArtifactCacheRoot(platformRoot, process.env.KB_MANAGED_ARTIFACT_CACHE_ROOT);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 64 * 1024) throw new Error("managed Marketplace request exceeds size limit");
    chunks.push(bytes);
  }
  const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!record(envelope) || Object.keys(envelope).some(key => key !== "mutation" && key !== "environment") || !record(envelope.environment)) throw new Error("invalid managed Marketplace helper envelope");
  const request = parseManagedGenerationMutation(envelope.mutation);
  const rawConfig = await readRawKbConfig(configRoot);
  const rawData = record(rawConfig?.data) ? rawConfig.data : {};
  const rawMarketplace = rawData.marketplace;
  const environmentNames = referencedMarketplaceEnvironment(record(rawMarketplace) ? rawMarketplace.sources : undefined);
  const providedEnvironment = envelope.environment;
  if (Object.keys(providedEnvironment).some(name => !environmentNames.includes(name)) || environmentNames.some(name => typeof providedEnvironment[name] !== "string")) {
    throw new Error("managed Marketplace credentials do not match configured source references");
  }
  for (const name of environmentNames) {
    const secret = providedEnvironment[name];
    if (typeof secret === "string" && secret.length > 0) requestSecretValues.add(secret);
  }
  const marketplace = interpolateConfig(rawMarketplace, true, providedEnvironment as NodeJS.ProcessEnv) as { sources?: MarketplaceSourcesConfig } | undefined;
  const configured = marketplace?.sources;
  if (!configured?.[0]) throw new Error("marketplace.sources is not configured");
  const sources = [
    ...(configured[0].kind === "registry" ? [new RegistryPackageSource({ registryUrl: configured[0].url, signingPublicKey: configured[0].signingPublicKey, authToken: configured[0].authToken })] : []),
    ...configured.flatMap(source => source?.kind === "npm" ? [new NpmPackageSource({ registryUrl: source.url, sealedArtifactCacheRoot: artifactCacheRoot })] : []),
  ];
  const service = new MarketplaceService({
    platformRoot,
    logger: new NoOpLogger(),
    sources,
    resolveSelectedAdapterSlot: async () => null,
  });
  const scope = { scope: "platform" as const };
  const resolvedBySpec = new Map<string, { id: string; version: string }>();
  let updatePackageIds: string[] = [];
  if (request.operation === "install") {
    for (const spec of request.specs) {
      let primaryKind: string | undefined;
      let identity: { id: string; version: string } | undefined;
      let resolved = false;
      for (const source of sources) {
        const candidate = await source.resolveIdentity(spec);
        if (candidate.status === "not-found-unowned") continue;
        resolved = true;
        if (candidate.status === "found") {
          primaryKind = candidate.package.primaryKind;
          identity = { id: candidate.package.id, version: candidate.package.version };
        }
        break;
      }
      if (!resolved || primaryKind === undefined || !identity) throw new Error("managed package is not present in configured sources");
      if (primaryKind !== "adapter" && primaryKind !== "plugin") throw new Error("managed generation install accepts plugin and adapter packages only");
      resolvedBySpec.set(spec, identity);
    }
  } else {
    const lockPath = path.join(platformRoot, ".kb", "marketplace.lock");
    const lock = JSON.parse(await fs.readFile(lockPath, "utf8")) as unknown;
    updatePackageIds = selectManagedAdapterUpdateIds(lock, request.packageIds);
  }
  const result = request.operation === "install"
    ? await service.install(scope, request.specs, { dev: request.dev })
    : await service.update(scope, updatePackageIds, { allowedSourceKinds: ["npm"] });
  const expectedCount = request.operation === "install" ? request.specs.length : updatePackageIds.length;
  if (result.installed.length !== expectedCount || result.installed.some(item => item.scope !== "platform"
    || (request.operation === "update" ? item.primaryKind !== "adapter" : item.primaryKind !== "adapter" && item.primaryKind !== "plugin"))) {
    const operationLabel = request.operation === "update" ? "update every requested platform adapter" : "install every requested platform package";
    throw new Error(`Marketplace helper did not ${operationLabel} (expected ${expectedCount}, received ${result.installed.length})`);
  }
  const installed = [];
  for (const item of result.installed) {
    if (!item.spec) throw new Error("Marketplace install result omitted its requested package spec");
    if (request.operation === "install") {
      const expected = resolvedBySpec.get(item.spec);
      if (!expected || expected.id !== item.id || expected.version !== item.version) throw new Error("Marketplace install result does not match the resolved request");
    } else if (!updatePackageIds.includes(item.id)) {
      throw new Error("Marketplace update result does not match the requested adapter");
    }
    const resolvedPackageRoot = await fs.realpath(item.packageRoot);
    const resolvedStage = await fs.realpath(platformRoot);
    const relative = path.relative(resolvedStage, resolvedPackageRoot);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("installed package escaped the candidate generation");
    installed.push({ requestedSpec: item.spec, packageId: item.id, version: item.version, resolvedVersion: item.version, primaryKind: item.primaryKind });
  }
  process.stdout.write(JSON.stringify({ schema: 1, operation: request.operation, installed, warnings: result.warnings }) + "\n");
}

export async function listManagedGenerationEnvRefs(): Promise<void> {
  const platformRoot = process.env.KB_PLATFORM_ROOT;
  const configRoot = process.env.KB_MARKETPLACE_CONFIG_ROOT;
  if (!platformRoot || !configRoot) throw new Error("managed Marketplace roots are not configured by the installer");
  await assertManagedCandidateRoots(platformRoot, configRoot);
  await validateManagedArtifactCacheRoot(platformRoot, process.env.KB_MANAGED_ARTIFACT_CACHE_ROOT);
  const raw = await readRawKbConfig(configRoot);
  const data = record(raw?.data) ? raw.data : {};
  const marketplace = record(data.marketplace) ? data.marketplace : {};
  process.stdout.write(JSON.stringify({ schema: 1, environment: referencedMarketplaceEnvironment(marketplace.sources) }) + "\n");
}
