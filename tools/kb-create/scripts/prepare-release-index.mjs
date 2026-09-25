#!/usr/bin/env node

// Publish-time preparation for the V2 release contract. This script owns the
// adapter from staged package manifests to the V2 index; the launcher only
// consumes the sealed result. It deliberately reads the exact tarballs from
// release stage instead of rebuilding or resolving npm tags.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const value = name => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
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
const platformPackage = value('--platform-package') ?? '@kb-labs/core-runtime';
const sdkPackage = value('--sdk-package') ?? '@kb-labs/sdk';
const platformVersion = value('--platform-version');
const sdkVersion = value('--sdk-version');
const binaryManifestPath = value('--binary-manifest') ? resolve(value('--binary-manifest')) : undefined;
if (flow === 'platform' && !binaryManifestPath) throw new Error('--binary-manifest is required for the unified platform release-index');
const sealerBin = value('--sealer-bin') ? resolve(value('--sealer-bin')) : undefined;
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
const platformMemberPackages = (value('--platform-member-packages') ?? '')
  .split(',')
  .map(item => item.trim())
  .filter(Boolean);
const adapterOverrides = value('--adapter-overrides') ? JSON.parse(value('--adapter-overrides')) : {};

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
const platform = byName.get(platformPackage);
if (!platform) throw new Error(`platform package ${platformPackage} is absent from stage manifest`);

// The default adapter map is part of the sealed platform configuration, not a
// suggestion for an already-installed workspace.  Its packages must therefore
// travel with the platform members.  Resolve subpath exports (for example
// "@scope/adapter/kv") back to their staged package, and fail closed when the
// release plan did not produce that package.
const stagedPackageForAdapter = configuredPackage => {
  const matches = stage
    .filter(item => configuredPackage === item.name || configuredPackage.startsWith(`${item.name}/`))
    .sort((left, right) => right.name.length - left.name.length);
  if (matches.length === 0) {
    throw new Error(`configured platform adapter ${configuredPackage} is absent from stage manifest`);
  }
  return matches[0].name;
};
const configuredPlatformAdapterPackages = platformAdapterConfig
  ? [...new Set(Object.values(platformAdapterConfig).map(configuredPackage => {
      if (typeof configuredPackage !== 'string' || configuredPackage.length === 0) {
        throw new Error('platform adapter configuration must contain package strings');
      }
      return stagedPackageForAdapter(configuredPackage);
    }))]
  : [];
// A release index is a portable installation baseline, not a copy of the
// maintainer's local development environment.  Keep every configured adapter
// package in the sealed member set so a consumer can opt into it later, but
// enable by default only what works on any machine with no credentials,
// endpoints or external services:
//   - serviceTransport: the transport needed to reach the installed service
//     graph;
//   - logger + logRingBuffer: in-process logging.  platform.logs (workflow
//     run logs, the logs WS channel, Studio log views) has no backend unless
//     a log adapter is bound, so without them a default install silently
//     shows no logs.  logRingBuffer is an extension adapter that taps the
//     logger, so the two are enabled together.
// Remote providers (and their credentials/endpoints) belong in a consumer
// overlay; otherwise an installed CLI can fail before it can even configure
// that overlay.
const PORTABLE_ADAPTER_SLOTS = ['serviceTransport', 'logger', 'logRingBuffer'];
const portablePlatformAdapterConfig = platformAdapterConfig?.serviceTransport
  ? Object.fromEntries(
      PORTABLE_ADAPTER_SLOTS
        .filter(slot => typeof platformAdapterConfig[slot] === 'string')
        .map(slot => [slot, platformAdapterConfig[slot]]),
    )
  : undefined;
const portablePlatformAdapterOptions = platformAdapterOptions?.serviceTransport
  ? { serviceTransport: platformAdapterOptions.serviceTransport }
  : undefined;
for (const packageName of platformMemberPackages) {
  if (!byName.has(packageName)) {
    throw new Error(`required platform member ${packageName} is absent from stage manifest`);
  }
}
const resolvedPlatformVersion = platformVersion ?? platform.version;
if (platform.version !== resolvedPlatformVersion) throw new Error(`platform version mismatch: stage=${platform.version}, expected=${resolvedPlatformVersion}`);

const sdk = byName.get(sdkPackage);
if (sdkVersion && (!sdk || sdk.version !== sdkVersion)) throw new Error(`SDK version mismatch for ${sdkPackage}`);
if (!sdk) throw new Error(`SDK package ${sdkPackage} is absent from stage manifest; compatibility cannot be validated without an exact SDK artifact`);
const binaries = binaryManifestPath ? JSON.parse(readFileSync(binaryManifestPath, 'utf8')).binaries : [];
if (!Array.isArray(binaries)) throw new Error('binary manifest must contain a binaries array');
for (const binary of binaries) {
  for (const field of ['id', 'os', 'arch', 'url', 'filename', 'sha256']) if (!binary[field]) throw new Error(`binary manifest entry is missing ${field}`);
  if (binary.version && binary.version !== resolvedPlatformVersion) throw new Error(`binary ${binary.id} version ${binary.version} does not match platform ${resolvedPlatformVersion}`);
}

const staging = resolve(`${artifactsDir}/v2-manifest-root`);
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

const manifestFor = item => {
  const packageDir = join(staging, 'node_modules', item.name);
  mkdirSync(packageDir, { recursive: true });
  const tarball = resolve(sourceDirByName.get(item.name) ?? artifactsDir, item.tarball);
  if (!existsSync(tarball)) throw new Error(`staged tarball is missing: ${tarball}`);
  const result = spawnSync('tar', ['-xzf', tarball, '-C', packageDir, '--strip-components=1'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`extract ${item.name}: ${result.stderr || result.stdout}`);
  for (const candidate of [join(packageDir, 'kb-create.manifest.json'), join(packageDir, 'dist', 'kb-create.manifest.json'), join(packageDir, 'dist', 'manifest.json')]) {
    if (existsSync(candidate)) return JSON.parse(readFileSync(candidate, 'utf8'));
  }
  const javascriptManifest = join(packageDir, 'dist', 'manifest.js');
  if (existsSync(javascriptManifest)) {
    const source = readFileSync(javascriptManifest, 'utf8');
    // Published service packages ship their manifest as compiled JS (rather
    // than JSON).  The release index is the installation contract, so it
    // must preserve their service graph instead of silently treating them as
    // ordinary packages.  Read only the declarative literals we need; never
    // execute a tarball fetched from the registry while preparing a release.
    if (/schema:\s*["']kb\.service\/1["']/.test(source)) {
      const id = source.match(/\bid:\s*["']([^"']+)["']/)?.[1];
      // Minifiers rewrite round numeric literals into scientific notation
      // (3000 -> 3e3), so the port literal must be captured whole rather than
      // truncated at the exponent marker.
      const port = Number(source.match(/\bport:\s*(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/)?.[1] ?? 0);
      const healthCheck = source.match(/\bhealthCheck:\s*["']([^"']*)["']/)?.[1];
      const dependsOnSource = source.match(/\bdependsOn:\s*\[([^\]]*)\]/)?.[1];
      const dependsOn = dependsOnSource
        ? [...dependsOnSource.matchAll(/["']([^"']+)["']/g)].map(match => match[1])
        : [];
      if (id) return { schema: 'kb.service/1', id, runtime: { port, healthCheck }, dependsOn };
    }
    const id = source.match(/\bid:\s*["']([^"']+)["']/)?.[1];
    const implementsSource = source.match(/\bimplements:\s*(\[[^\]]+\]|["'][^"']+["'])/)?.[1];
    const implementsValue = implementsSource?.startsWith('[')
      ? [...implementsSource.matchAll(/["']([^"']+)["']/g)].map(match => match[1])
      : implementsSource?.slice(1, -1);
    if (id && implementsValue) {
      return { schema: 'kb.adapter/1', id, implements: implementsValue };
    }
  }
  return undefined;
};

// A package declares the configuration it needs (non-secret paths, secrets and
// the environment variables/services they feed) in a `kb-create.requirements.json`
// shipped in its tarball. It is a SEPARATE file from `kb-create.manifest.json` on
// purpose: manifestFor() above treats a `kb-create.manifest.json` as the
// package's *primary* manifest, which would hide a service's `kb.service/1`
// graph (dist/manifest.js) and drop the service from the index. This file only
// adds requirements and never replaces the primary manifest. The sealer
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
// names don't reliably follow that id (e.g. @kb-labs/release-manager-cli's
// manifest declares id "@kb-labs/release"). Re-deriving IDs independently
// for members caused the release index to write "release-manager-cli" as
// that member's id while the package's own kb-create.manifest.json (written
// below using normalizedID) shipped "release" — a divergence that failed
// installed.Load()'s id equality check at publish time.
const normalizedIdByPackage = new Map();
for (const item of stage) {
  const manifest = manifestFor(item) ?? adapterOverrides[item.name];
  const normalizedID = item.name === platformPackage
    ? 'platform'
    : item.name === sdkPackage
      ? 'sdk'
      : manifest?.schema === 'kb.service/1'
        ? manifest.id
        : manifest?.schema === 'kb.adapter/1'
          ? manifest.id
        : manifest?.schema === 'kb.plugin/3'
          ? pluginIdFor(manifest, item.name)
        : idFor(item.name);
  normalizedIdByPackage.set(item.name, normalizedID);
  const generatedRequirements = item.name === platformPackage
    ? [
        ...(portablePlatformAdapterConfig ? [{ id: 'platform.adapters', path: '/platform/adapters', default: portablePlatformAdapterConfig }] : []),
        ...(portablePlatformAdapterOptions ? [{ id: 'platform.adapterOptions', path: '/platform/adapterOptions', default: portablePlatformAdapterOptions }] : []),
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
    adapters.push({ ...component(item, manifest, manifest.id ?? idFor(item.name)), provides: capabilities });
  }
}

const sdkPackageJSON = packageJSONFor(sdk);
const sdkPlatformRange = sdkPackageJSON.peerDependencies?.[platformPackage];
if (!sdkPlatformRange) throw new Error(`${sdkPackage} does not declare a peer dependency on ${platformPackage}`);
if (!satisfies(resolvedPlatformVersion, sdkPlatformRange)) {
  throw new Error(`${sdkPackage}@${sdk.version} rejects ${platformPackage}@${resolvedPlatformVersion}: ${sdkPlatformRange}`);
}

const exportValue = {
  channels: { [channel]: resolvedPlatformVersion },
  compatibility: {
    schema: 'kb.release-compatibility/2',
    labels: [
      { id: `platform@${resolvedPlatformVersion}`, kind: 'platform', artifactId: 'platform', version: resolvedPlatformVersion, requires: [{ label: `sdk@${sdk.version}`, constraint: sdkPlatformRange }], status: 'prepared', validatedBy: ['stage', 'package-manifest', 'artifact-hash', 'sdk-peer-dependency'] },
      { id: `sdk@${sdk.version}`, kind: 'sdk', artifactId: 'sdk', version: sdk.version, status: 'prepared', validatedBy: ['stage', 'package-manifest', 'artifact-hash', 'sdk-peer-dependency'] },
      ...binaries.map(binary => ({ id: `binary:${binary.id}@${resolvedPlatformVersion}:${binary.os}/${binary.arch}`, kind: 'binary', artifactId: binary.id, version: resolvedPlatformVersion, requires: [{ label: `platform@${resolvedPlatformVersion}` }, { label: `sdk@${sdk.version}` }], status: 'prepared', validatedBy: ['release-asset', 'artifact-hash', 'post-publish-smoke'] })),
    ],
  },
  platforms: [{
    id: 'platform',
    version: resolvedPlatformVersion,
    package: platform.name,
    tarball: tarballURL(platform),
    sha256: platform.sha256,
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
    ],
    profiles: { default: { platformVersion: resolvedPlatformVersion, services: services.map(({ packageName, ...service }) => service) } },
    binaries,
    members: [...new Set([
      ...services.map(service => service.packageName),
      ...platformMemberPackages,
      ...configuredPlatformAdapterPackages,
    ])].map(packageName => {
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

const exportPath = join(artifactsDir, 'manifest-export.json');
writeFileSync(exportPath, `${JSON.stringify(exportValue, null, 2)}\n`);

const sealer = sealerBin
  ? spawnSync(sealerBin, ['--input', exportPath, '--manifest-root', staging, '--output', output], { stdio: 'inherit' })
  : spawnSync('go', ['run', './v2/cmd/kb-create-release-index', '--input', exportPath, '--manifest-root', staging, '--output', output], {
      cwd: resolve(new URL('../', import.meta.url).pathname),
      stdio: 'inherit',
    });
if (sealer.status !== 0) process.exit(sealer.status ?? 1);

function idFor(packageName) {
  return packageName.split('/').pop().replace(/-entry$/, '');
}

// A plugin's kb.plugin/3 manifest is the source of truth for its catalog ID
// (e.g. "@kb-labs/release" -> "release"). Stripping the "-entry" suffix off
// the npm package name (idFor) is only a fallback for manifests that don't
// declare one — package names don't reliably follow the manifest's id (e.g.
// @kb-labs/release-manager-cli's manifest declares id "@kb-labs/release").
function pluginIdFor(manifest, packageName) {
  if (typeof manifest.id === 'string' && manifest.id.startsWith('@')) {
    return manifest.id.split('/').pop();
  }
  return idFor(packageName);
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

function satisfies(version, range) {
  const candidate = parseVersion(version);
  return range.split('||').some(alternative => alternative.trim().split(/\s+/).filter(Boolean).every(token => compareToken(candidate, token)));
}

function compareToken(candidate, token) {
  if (token === '*' || token.toLowerCase() === 'latest') return true;
  const operator = token.match(/^(\^|~|>=|<=|>|<|=)?(.*)$/)?.[1] ?? '=';
  const raw = token.slice(operator === '=' ? 0 : operator.length);
  const target = parseVersion(raw);
  const comparison = compareVersion(candidate, target);
  if (operator === '^') return comparison >= 0 && candidate[0] === target[0];
  if (operator === '~') return comparison >= 0 && candidate[0] === target[0] && candidate[1] === target[1];
  if (operator === '>=') return comparison >= 0;
  if (operator === '<=') return comparison <= 0;
  if (operator === '>') return comparison > 0;
  if (operator === '<') return comparison < 0;
  return comparison === 0;
}

function parseVersion(value) {
  const match = String(value).trim().replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) throw new Error(`invalid semver in compatibility declaration: ${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersion(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index] ? 1 : -1;
  }
  return 0;
}
