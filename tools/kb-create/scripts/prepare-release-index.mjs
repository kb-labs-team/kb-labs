#!/usr/bin/env node

// Publish-time preparation for the V2 release contract. This script owns the
// adapter from staged package manifests to the V2 index; the launcher only
// consumes the sealed result. It deliberately reads the exact tarballs from
// release artifact create instead of rebuilding or resolving npm tags.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import {
  DEFAULT_HOST_PACKAGE,
  DEFAULT_PLATFORM_PACKAGE,
  DEFAULT_SDK_PACKAGE,
  readPlatformReleaseConfig,
  configuredAdapterPackages,
  platformPackageRoots,
  shippedPlatformPackageSet,
} from './platform-release-config.mjs';

const args = process.argv.slice(2);
const value = name => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const values = name => args.flatMap((argument, index) => argument === name ? [args[index + 1]] : []);
const required = name => {
  const result = value(name);
  if (!result) throw new Error(`${name} is required`);
  return result;
};

const artifactsDir = resolve(required('--artifacts-dir'));
const sdkArtifactsDir = value('--sdk-artifacts-dir') ? resolve(value('--sdk-artifacts-dir')) : undefined;
const output = resolve(required('--output'));
const flow = required('--flow');
const channel = value('--channel') ?? 'stable';
const registry = value('--registry') ?? 'https://registry.npmjs.org';
const platformPackage = value('--platform-package') ?? DEFAULT_PLATFORM_PACKAGE;
const sdkPackage = value('--sdk-package') ?? DEFAULT_SDK_PACKAGE;
const binaryManifestPath = value('--binary-manifest') ? resolve(value('--binary-manifest')) : undefined;
if (flow === 'platform' && !binaryManifestPath) throw new Error('--binary-manifest is required for the unified platform release-index');
const minLauncherVersion = value('--min-launcher-version');
const provenanceManifestPath = resolve(required('--provenance-manifest'));
const releaseNotes = value('--release-notes');
const sealerBin = value('--sealer-bin') ? resolve(value('--sealer-bin')) : undefined;
const historyIndexes = values('--history-index').map(path => resolve(path));
const platformRequires = (value('--platform-requires') ?? '')
  .split(',')
  .map(item => item.trim())
  .filter(Boolean)
  .map(capability => ({ capability, requiredBy: 'platform' }));
const platformAdapterConfig = value('--platform-adapter-config')
  ? JSON.parse(value('--platform-adapter-config'))
  : undefined;
const platformAdapterOptions = value('--platform-adapter-options')
  ? JSON.parse(value('--platform-adapter-options'))
  : undefined;
const releaseConfigPath = resolve(value('--release-config') ?? fileURLToPath(new URL('../config/platform-release.jsonc', import.meta.url)));
const marketplaceSources = readPlatformReleaseConfig(releaseConfigPath).marketplaceSources;
if (flow === 'platform' && (!Array.isArray(marketplaceSources) || marketplaceSources.length === 0)) {
  throw new Error('platform release config must declare marketplace.sources for every platform install');
}
const platformMemberPackages = (value('--platform-member-packages') ?? '')
  .split(',')
  .map(item => item.trim())
  .filter(Boolean);
// The platform runs as ONE supervised host process (ADR-0043/0045); the sealed
// index declares it, and the launcher has no other way to start a platform. The
// host package is a platform member, its executable comes from its own bin, and
// a recovery tool (kb-create doctor --recover) is declared only when it ships.
const hostPackage = value('--host-package') ?? DEFAULT_HOST_PACKAGE;
const hostHealthURL = value('--host-health-url') ?? 'http://127.0.0.1:4000/health';

const readStage = directory => {
  const entries = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
  if (!Array.isArray(entries) || entries.length === 0) throw new Error(`stage manifest contains no artifacts: ${directory}`);
  return entries.map(item => ({ item, directory }));
};
const stagedEntries = [...readStage(artifactsDir), ...(sdkArtifactsDir ? readStage(sdkArtifactsDir) : [])];
const stage = stagedEntries.map(({ item }) => item);
if (new Set(stage.map(item => item.name)).size !== stage.length) throw new Error('stage manifests contain duplicate package names');

const byName = new Map(stage.map(item => [item.name, item]));
const sourceDirByName = new Map(stagedEntries.map(({ item, directory }) => [item.name, directory]));
const sizeBytesFor = item => statSync(resolve(sourceDirByName.get(item.name) ?? artifactsDir, item.tarball)).size;
const platform = byName.get(platformPackage);
if (!platform) throw new Error(`platform package ${platformPackage} is absent from stage manifest`);
const resolvedPlatformVersion = platform.version;

// The default adapter map is part of the sealed platform configuration, not a
// suggestion for an already-installed workspace.  Its packages must therefore
// travel with the platform members.  Resolve subpath exports (for example
// "@scope/adapter/kv") back to their staged package, and fail closed when the
// release plan did not produce that package.
const configuredPlatformAdapterPackages = configuredAdapterPackages(platformAdapterConfig, byName);
// Keep the bindings and options for precisely the required platform slots in
// the release index. This makes fresh-install defaults travel with the same
// capability list the resolver uses to produce provider bindings.
const requiredAdapterSlots = new Set(platformRequires.map(({ capability }) => capability));
const portablePlatformAdapterConfig = platformAdapterConfig
  ? Object.fromEntries(Object.entries(platformAdapterConfig).filter(([slot]) => requiredAdapterSlots.has(slot)))
  : undefined;
const portablePlatformAdapterOptions = platformAdapterOptions
  ? Object.fromEntries(Object.entries(platformAdapterOptions).filter(([slot]) => requiredAdapterSlots.has(slot)))
  : undefined;
for (const packageName of platformMemberPackages) {
  if (!byName.has(packageName)) {
    throw new Error(`required platform member ${packageName} is absent from stage manifest`);
  }
}
const sdk = byName.get(sdkPackage);
if (!sdk) throw new Error(`SDK package ${sdkPackage} is absent from stage manifest; compatibility cannot be validated without an exact SDK artifact`);
const binaries = binaryManifestPath ? JSON.parse(readFileSync(binaryManifestPath, 'utf8')).binaries : [];
if (!Array.isArray(binaries)) throw new Error('binary manifest must contain a binaries array');
for (const binary of binaries) {
  for (const field of ['id', 'version', 'os', 'arch', 'url', 'filename', 'sha256']) if (!binary[field]) throw new Error(`binary manifest entry is missing ${field}`);
}
const staging = mkdtempSync(join(tmpdir(), 'kb-release-index-manifest-root-'));
process.on('exit', () => rmSync(staging, { recursive: true, force: true }));
mkdirSync(staging, { recursive: true });

const manifestFor = item => {
  const packageDir = join(staging, 'node_modules', item.name);
  mkdirSync(packageDir, { recursive: true });
  const tarball = resolve(sourceDirByName.get(item.name) ?? artifactsDir, item.tarball);
  if (!existsSync(tarball)) throw new Error(`staged tarball is missing: ${tarball}`);
  const result = spawnSync('tar', ['-xzf', tarball, '-C', packageDir, '--strip-components=1'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`extract ${item.name}: ${result.stderr || result.stdout}`);
  const artifact = join(packageDir, 'dist', 'manifest.json');
  if (existsSync(artifact)) {
    const manifest = JSON.parse(readFileSync(artifact, 'utf8'));
    if (!['kb.service/1', 'kb.adapter/1', 'kb.plugin/3'].includes(manifest?.schema)) {
      throw new Error(`${item.name} dist/manifest.json uses unsupported schema ${manifest?.schema ?? '(missing)'}`);
    }
    return manifest;
  }
  const packageJSON = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  const declarationField = packageJSON.kb?.adapter?.manifest ? 'kb.adapter.manifest' : 'kb.manifest';
  const declaredManifest = packageJSON.kb?.adapter?.manifest ?? packageJSON.kb?.manifest;
  if (declaredManifest) throw new Error(`${item.name} declares ${declarationField} but its build did not emit dist/manifest.json; rebuild the package with @kb-labs/devkit/tsup/node`);
  return undefined;
};

// Service packages declare package-specific configuration in a
// `kb-create.requirements.json`. Adapter packages receive this artifact from the
// manifest build emitter, which projects their configSchema into the same
// requirement format. The file never replaces a package's service, plugin, or
// adapter contract. The sealer
// validates each requirement's shape; here we only fail closed on a malformed
// file, so a typo cannot silently ship a package without its requirements.
const REQUIREMENTS_FILE = 'kb-create.requirements.json';
const REQUIREMENTS_SCHEMA = 'kb.create.requirements/v1';
const requirementsFor = item => {
  const packageDir = join(staging, 'node_modules', item.name);
  for (const candidate of [join(packageDir, REQUIREMENTS_FILE), join(packageDir, 'dist', REQUIREMENTS_FILE)]) {
    if (!existsSync(candidate)) continue;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(candidate, 'utf8'));
    } catch (error) {
      throw new Error(`${item.name} ships an unreadable ${REQUIREMENTS_FILE}: ${error.message}`);
    }
    if (parsed?.schema !== REQUIREMENTS_SCHEMA || !Array.isArray(parsed.requirements)) {
      throw new Error(`${item.name} ships an invalid ${REQUIREMENTS_FILE}: expected schema ${REQUIREMENTS_SCHEMA} and a requirements array`);
    }
    return parsed.requirements;
  }
  return [];
};
const uniqueRequirements = (packageName, list) => {
  const seen = new Set();
  for (const requirement of list) {
    if (typeof requirement?.id !== 'string' || requirement.id === '') {
      throw new Error(`${packageName} declares a configuration requirement without an id`);
    }
    if (seen.has(requirement.id)) {
      throw new Error(`${packageName} declares configuration requirement ${requirement.id} more than once`);
    }
    seen.add(requirement.id);
  }
  return list;
};

const packageJSONFor = item => {
  const path = join(staging, 'node_modules', item.name, 'package.json');
  if (!existsSync(path)) throw new Error(`${item.name} tarball has no package.json`);
  return JSON.parse(readFileSync(path, 'utf8'));
};

const tarballURL = item => {
  const packageBase = item.name.split('/').pop();
  return `${registry.replace(/\/$/, '')}/${item.name}/-/${packageBase}-${item.version}.tgz`;
};
const component = (item, manifest, id = item.name.split('/').pop().replace(/-entry$/, '')) => ({
  id,
  version: item.version,
  package: item.name,
  tarball: tarballURL(item),
  sha256: item.sha256,
  sizeBytes: sizeBytesFor(item),
  ...(manifest?.compatibility?.platformRange ? { platformRange: manifest.compatibility.platformRange } : {}),
  ...(manifest?.compatibility?.sdkRange ? { sdkRange: manifest.compatibility.sdkRange } : {}),
  config: manifest?.requirements ?? [],
});

const services = [];
const plugins = [];
const adapters = [];
// Single source of truth for each staged package's normalized catalog ID.
// The platform `members[]` array (built below, after this loop) MUST reuse
// these exact same IDs rather than re-deriving them from packageName via
// idFor()/-entry stripping — a plugin's own kb.plugin/3 manifest is the
// source of truth for its ID (see pluginIdFor's doc comment), and package
// names don't reliably follow that id (e.g. @kb-labs/release's
// manifest declares id "@kb-labs/release"). Re-deriving IDs independently
// for members caused the release index to write "release-manager-cli" as
// that member's id while the package's own kb-create.manifest.json (written
// below using normalizedID) shipped "release" — a divergence that failed
// installed.Load()'s id equality check at publish time.
const normalizedIdByPackage = new Map();
for (const item of stage) {
  const manifest = manifestFor(item);
  const normalizedID = item.name === platformPackage
    ? 'platform'
    : item.name === sdkPackage
      ? 'sdk'
      : manifest?.schema === 'kb.service/1'
        ? manifest.id
        : manifest?.schema === 'kb.adapter/1'
          ? manifest.id
        : manifest?.schema === 'kb.plugin/3'
          ? pluginIdFor(manifest)
        : idFor(item.name);
  normalizedIdByPackage.set(item.name, normalizedID);
  const generatedRequirements = item.name === platformPackage
    ? [
        ...(portablePlatformAdapterConfig ? [{ id: 'platform.adapters', path: '/platform/adapters', default: portablePlatformAdapterConfig }] : []),
        ...(portablePlatformAdapterOptions ? [{ id: 'platform.adapterOptions', path: '/platform/adapterOptions', default: portablePlatformAdapterOptions }] : []),
        ...(marketplaceSources ? [{ id: 'marketplace.sources', path: '/marketplace/sources', default: marketplaceSources }] : []),
      ]
    : [];
  writeFileSync(join(staging, 'node_modules', item.name, 'kb-create.manifest.json'), `${JSON.stringify({
    schema: 'kb.create.artifact-manifest/v2',
    id: normalizedID,
    package: item.name,
    version: item.version,
    requirements: uniqueRequirements(item.name, [
      ...(manifest?.schema === 'kb.create.artifact-manifest/v2' ? manifest.requirements ?? [] : []),
      ...requirementsFor(item),
      ...generatedRequirements,
    ]),
  })}\n`);
  if (!manifest) continue;
  if (manifest.schema === 'kb.service/1') {
    const packageJSON = packageJSONFor(item);
    services.push({
      id: manifest.id,
      packageName: item.name,
      command: manifest.bin ? Object.keys(manifest.bin)[0] : Object.keys(packageJSON.bin ?? {})[0] ?? item.name.split('/').pop(),
      port: manifest.runtime?.port ?? 0,
      healthCheck: manifest.runtime?.healthCheck ?? '',
      dependsOn: manifest.dependsOn ?? [],
      required: true,
    });
  } else if (manifest.schema === 'kb.plugin/3') {
    const pluginId = pluginIdFor(manifest, item.name);
    const requires = (manifest.platform?.requires ?? []).map(capability => ({ capability, requiredBy: pluginId }));
    plugins.push({ ...component(item, manifest, pluginId), requires });
  } else if (manifest.schema === 'kb.adapter/1') {
    const capabilities = (Array.isArray(manifest.implements) ? manifest.implements : [manifest.implements])
      .filter(Boolean)
      .map(interfaceToCapability);
    if (manifest.defaultFor !== undefined && (typeof manifest.defaultFor !== 'object' || Array.isArray(manifest.defaultFor) || manifest.defaultFor === null)) {
      throw new Error(`${item.name} defaultFor must map provided capabilities to module entry points`);
    }
    const defaults = Object.keys(manifest.defaultFor ?? {});
    for (const capability of defaults) {
      if (!capabilities.includes(capability)) {
        throw new Error(`${item.name} declares defaultFor ${capability} but does not implement it`);
      }
    }
    for (const [capability, entrypoint] of Object.entries(manifest.defaultFor ?? {})) {
      if (!Array.isArray(entrypoint)) {
        throw new Error(`${item.name} defaultFor ${capability} must declare module path segments`);
      }
    }
    adapters.push({
      ...component(item, manifest, manifest.id ?? idFor(item.name)),
      provides: capabilities,
      ...(defaults.length ? { defaultFor: defaults } : {}),
    });
  }
}

const sdkPackageJSON = packageJSONFor(sdk);
const sdkPlatformRange = sdkPackageJSON.dependencies?.[platformPackage];
if (!sdkPlatformRange) throw new Error(`${sdkPackage} does not declare a dependency on ${platformPackage}`);
// The SDK package owns its runtime dependencies; the package manager resolves
// those from the SDK package manifest. Platform members are only explicit roots.
const platformMemberRoots = platformPackageRoots({
  servicePackages: services.map(service => service.packageName),
  hostPackage,
  platformMembers: platformMemberPackages,
  adapterPackages: configuredPlatformAdapterPackages,
  platformPackage,
  sdkPackage: sdk.name,
});
const platformMemberArtifacts = new Set(platformMemberRoots);
// The release graph is the owner for peer availability. It includes the exact
// staged dependency closure of the packages installed with the platform.
const platformManifests = new Map(stage.map(item => [item.name, packageJSONFor(item)]));
const platformProvidedPackages = shippedPlatformPackageSet(
  platformMemberRoots,
  platformManifests,
  platformPackage,
);
const platformPackageNames = [...platformProvidedPackages];
const platformPeerViolations = [];
const packagesWithPlatformPeers = new Set([...platformPackageNames, ...stage.map(item => item.name)]);
for (const packageName of packagesWithPlatformPeers) {
  const item = byName.get(packageName);
  if (!item) continue;
  const packageJSON = packageJSONFor(item);
  const peers = new Set(Object.keys(packageJSON.peerDependencies ?? {}));
  const optionalPeers = new Set(Object.entries(packageJSON.peerDependenciesMeta ?? {})
    .filter(([, metadata]) => metadata?.optional === true)
    .map(([name]) => name));
  for (const peer of peers) {
    if (!platformManifests.has(peer) || optionalPeers.has(peer) || platformProvidedPackages.has(peer)) continue;
    platformPeerViolations.push(`${packageName} declares platform peer ${peer}, which the platform package graph does not provide`);
  }
}
for (const packageName of platformPackageNames) {
  const item = byName.get(packageName);
  // Preserve the host-specific validation below, which reports the release
  // contract violation with its actionable package role.
  if (!item && packageName === hostPackage) continue;
  if (!item) throw new Error(`platform package ${packageName} is absent from stage manifest`);
}
if (platformPeerViolations.length > 0) {
  throw new Error(`platform peer validation failed:\n${platformPeerViolations.map(violation => `- ${violation}`).join('\n')}`);
}

const hostItem = byName.get(hostPackage);
if (!hostItem) throw new Error(`host package ${hostPackage} is absent from stage manifest; a platform release must ship the host`);
const hostBins = packageJSONFor(hostItem).bin ?? {};
if (typeof hostBins['kb-host'] !== 'string') throw new Error(`${hostPackage} must declare a kb-host executable in its package.json bin`);
const host = {
  command: 'node_modules/.bin/kb-host',
  healthUrl: hostHealthURL,
  ...(typeof hostBins['kb-recover'] === 'string' ? { recover: { command: 'node_modules/.bin/kb-recover' } } : {}),
};

const exportValue = {
  provenance: JSON.parse(readFileSync(provenanceManifestPath, 'utf8')),
  channels: { [channel]: resolvedPlatformVersion },
  compatibility: {
    schema: 'kb.release-compatibility/2',
    labels: [
      { id: `platform@${resolvedPlatformVersion}`, kind: 'platform', artifactId: 'platform', version: resolvedPlatformVersion, requires: [{ label: `sdk@${sdk.version}`, constraint: sdkPlatformRange }], status: 'prepared', validatedBy: ['stage', 'package-manifest', 'artifact-hash', 'sdk-runtime-dependency'] },
      { id: `sdk@${sdk.version}`, kind: 'sdk', artifactId: 'sdk', version: sdk.version, status: 'prepared', validatedBy: ['stage', 'package-manifest', 'artifact-hash', 'sdk-runtime-dependency'] },
      ...binaries.map(binary => { const version = binary.version; return { id: `binary:${binary.id}@${version}:${binary.os}/${binary.arch}`, kind: 'binary', artifactId: binary.id, version, requires: [{ label: `platform@${resolvedPlatformVersion}` }, { label: `sdk@${sdk.version}` }], status: 'prepared', validatedBy: ['release-asset', 'artifact-hash', 'post-publish-smoke'] }; }),
    ],
  },
  platforms: [{
    id: 'platform',
    version: resolvedPlatformVersion,
    ...(releaseNotes !== undefined ? { releaseNotes } : {}),
    package: platform.name,
    tarball: tarballURL(platform),
    sha256: platform.sha256,
    sizeBytes: sizeBytesFor(platform),
    ...(minLauncherVersion ? { minLauncherVersion } : {}),
    requires: platformRequires,
    config: [
      ...(portablePlatformAdapterConfig ? [{
        id: 'platform.adapters',
        path: '/platform/adapters',
        default: JSON.stringify(portablePlatformAdapterConfig),
      }] : []),
      ...(portablePlatformAdapterOptions ? [{
        id: 'platform.adapterOptions',
        path: '/platform/adapterOptions',
        default: JSON.stringify(portablePlatformAdapterOptions),
      }] : []),
      ...(marketplaceSources ? [{
        id: 'marketplace.sources',
        path: '/marketplace/sources',
        default: JSON.stringify(marketplaceSources),
      }] : []),
    ],
    host,
    profiles: {
      default: { platformVersion: platform.version, services: services.map(({ packageName, ...service }) => service) },
      client: { profile: 'client', platformVersion: platform.version, services: [] },
    },
    binaries,
    members: [...platformMemberArtifacts].filter(packageName => packageName !== sdk.name).map(packageName => {
      const item = byName.get(packageName);
      return item ? component(item, undefined,
        normalizedIdByPackage.get(packageName) ?? idFor(packageName),
      ) : undefined;
    }),
  }],
  sdks: sdk ? [component(sdk, undefined, 'sdk')] : [],
  plugins,
  adapters,
};

mkdirSync(dirname(output), { recursive: true });
const exportPath = join(dirname(output), 'manifest-export.json');
writeFileSync(exportPath, `${JSON.stringify(exportValue, null, 2)}\n`);

const sealer = sealerBin
  ? spawnSync(sealerBin, ['--input', exportPath, '--manifest-root', staging, '--output', output,
    ...historyIndexes.flatMap(index => ['--history-index', index])], { stdio: 'inherit' })
  : spawnSync('go', ['run', './v2/cmd/kb-create-release-index', '--input', exportPath, '--manifest-root', staging, '--output', output,
    ...historyIndexes.flatMap(index => ['--history-index', index])], {
      cwd: resolve(new URL('../', import.meta.url).pathname),
      stdio: 'inherit',
    });
if (sealer.status !== 0) process.exit(sealer.status ?? 1);

function idFor(packageName) {
  return packageName.split('/').pop().replace(/-entry$/, '');
}

// A plugin's kb.plugin/3 manifest is the source of truth for its ID, including
// its scope. Package names and release-index short names are not plugin IDs.
function pluginIdFor(manifest) {
  return manifest.id;
}

// Convert an adapter interface name (e.g. "IServiceTransport", "IKVStore",
// "ILLM") to the camelCase capability token the platform requires by (e.g.
// "serviceTransport", "kvStore", "llm"). Lowercasing every capital letter
// (the previous approach) collapses "IServiceTransport" to
// "servicetransport", which never matches the "serviceTransport" capability
// the platform declares — so no adapter is ever found and bootstrap fails
// with KB_INSTALL_PROVIDER_UNRESOLVED. Only the leading run of capitals needs
// lowercasing, and only up to (not including) the capital that starts the
// next word — "KVStore" -> "kvStore", not "kVStore" or "kvstore".
function interfaceToCapability(name) {
  const stripped = name.replace(/^I/, '');
  return stripped.replace(/^[A-Z]+/, (leading) => {
    if (leading.length <= 1 || leading.length === stripped.length) return leading.toLowerCase();
    return leading.slice(0, -1).toLowerCase() + leading.slice(-1);
  });
}

const digest = createHash('sha256').update(readFileSync(output)).digest('hex');
console.log(`Release index prepared: ${output}`);
console.log(`Release index bytes: ${digest}`);
