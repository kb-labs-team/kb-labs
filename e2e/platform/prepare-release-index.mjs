#!/usr/bin/env node

// Build the E2E platform's V2 release index from the exact tarballs that are
// copied into the image. The registry manifest remains the E2E composition
// source, while the sealed index is the only input consumed by kb-create.

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { clearGeneratedReleasePackages, readPackedPackageManifests } from './release-index-package-stage.mjs';
import { binaryManifestForVersion, ensureBinaryManifestDirectory } from './binary-manifest-map.mjs';
import { deriveCandidateVersion, prepareJourneyUpdatePackages } from './journey-update-packages.mjs';
import { invokePackageProvenanceOwner } from 'kb-create/scripts/package-provenance.mjs';
import { stablePlatformVersion } from './release-index-version.mjs';
import { prepareReleaseProvenance } from './release-provenance.mjs';
import { readPlatformReleaseConfig, releaseArtifactPackageNames, shippedPlatformPackageSet } from 'kb-create/scripts/platform-release-config.mjs';

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

const packagesDir = resolve(required('--packages-dir'));
const registryManifest = JSON.parse(readFileSync(resolve(required('--registry-manifest')), 'utf8'));
const releaseConfigPath = resolve(value('--release-config') ?? 'tools/kb-create/config/platform-release.jsonc');
const releaseConfig = readPlatformReleaseConfig(releaseConfigPath);
const output = resolve(required('--output'));
ensureBinaryManifestDirectory(output);
clearGeneratedReleasePackages(packagesDir, resolve(output, '..'));
const sealer = resolve(required('--sealer'));
const binaryDirectory = resolve(required('--binary-dir'));
const binaryManifest = resolve(required('--binary-manifest'));
const binaryManifestMap = value('--binary-manifest-map') ? resolve(value('--binary-manifest-map')) : undefined;
const binaryVersion = required('--binary-version');
const sourceRevision = required('--source-revision');
const binaryBaseUrl = value('--binary-base-url') ?? process.env.KB_JOURNEY_BINARY_BASE_URL ?? 'http://origin:8080/journey-candidate';
const packageRegistry = value('--package-registry') ?? process.env.KB_JOURNEY_REGISTRY_URL ?? 'http://verdaccio:4873';
const prepareScript = resolve(value('--prepare-script') ?? '/src/kb-create/scripts/prepare-release-index.mjs');
const stage = resolve(process.env.KB_JOURNEY_RELEASE_STAGE ?? '/tmp/kb-e2e-release-stage');

const binaryManifestFor = version => binaryManifestForVersion(version, binaryManifest, binaryManifestMap, binaryVersion);
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

const artifacts = readPackedPackageManifests(packagesDir);
const packageManifests = new Map(artifacts.map(({ packageJSON }) => [packageJSON.name, packageJSON]));
const releaseRoots = releaseArtifactPackageNames(registryManifest, releaseConfig.platformMembers);
const wantedSet = shippedPlatformPackageSet(releaseRoots, packageManifests);
const packages = new Map();

for (const { filename, artifactPath: tarball, packageJSON } of artifacts) {
  if (wantedSet.has(packageJSON.name)) {
    copyFileSync(tarball, join(stage, filename));
    packages.set(packageJSON.name, {
      name: packageJSON.name, version: packageJSON.version, tarball: filename,
      sha256: invokePackageProvenanceOwner(sealer, ['digest', 'sha256', tarball]).digest,
    });
  }
}

for (const name of wantedSet) {
  if (!packages.has(name)) throw new Error(`platform dependency package is not packed: ${name}`);
}

writeFileSync(join(stage, 'manifest.json'), `${JSON.stringify([...packages.values()], null, 2)}\n`);
const provenanceManifest = writeProvenanceManifest(stage, sourceRevision);

const adapterConfig = JSON.stringify(releaseConfig.adapters);
const adapterOptions = JSON.stringify({
  ...releaseConfig.adapterOptions,
  serviceTransport: {
    ...releaseConfig.adapterOptions.serviceTransport,
    services: Object.fromEntries((registryManifest.services ?? [])
      .filter(({ id, port }) => id && port)
      .map(({ id, port }) => [id, { url: `http://127.0.0.1:${port}` }])),
  },
});
const platformRequires = releaseConfig.platformRequires.join(',');
// Built-in platform members ship with the platform release. Other plugins are
// published separately and selected by the marketplace.
const platformMembers = releaseConfig.platformMembers.join(',');
const journeyReleaseNotes = 'Prepared candidate platform release for update verification.';
const releaseNotesArgs = ['--release-notes', journeyReleaseNotes];
const adapterOverrides = JSON.stringify({
  '@kb-labs/adapters-service-transport-http': {
    schema: 'kb.adapter/1',
    id: 'service-transport-http',
    implements: 'IServiceTransport',
  },
});
const result = spawnSync(process.execPath, [
  prepareScript,
  '--flow', 'platform',
  '--channel', 'stable',
  '--artifacts-dir', stage,
  '--provenance-manifest', provenanceManifest,
  '--binary-manifest', binaryManifestFor(binaryVersion),
  // The platform composition under test needs a log store: workflow run logs
  // (GET /runs/:id/logs, the logs WS channel) are served by platform.logs,
  // which has no backend unless logRingBuffer or logPersistence is bound.
  // logRingBuffer is an extension adapter that taps the `logger` adapter
  // ("Extension logRingBuffer cannot connect: target adapter logger not
  // found" otherwise), so both must be required. Declaring requirements is
  // how the V2 resolver binds a capability (installed-but-unrequired
  // adapters are deliberately left unbound); .kb/overlays cannot rebind
  // platform adapters.
  '--platform-requires', platformRequires,
  '--platform-adapter-config', adapterConfig,
  '--platform-adapter-options', adapterOptions,
  '--platform-member-packages', platformMembers,
  '--adapter-overrides', adapterOverrides,
  '--registry', packageRegistry,
  '--output', output,
  ...releaseNotesArgs,
  '--sealer-bin', sealer,
], { stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);

// The update journey needs a second sealed release. Advance every artifact in
// the release registry manifest while retaining its code, so the stable channel
// resolves one coherent N+1 release across the selected platform composition.
const baseVersion = stablePlatformVersion(JSON.parse(readFileSync(output, 'utf8')));
const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(baseVersion ?? '');
if (!match) throw new Error(`platform release version is not a stable semantic version: ${baseVersion}`);
const updateVersion = deriveCandidateVersion(`${match[1]}.${match[2]}.${Number(match[3]) + 1}`, stage, registryManifest, sealer, releaseConfig.platformMembers);
const jumpVersion = `${match[1]}.${match[2]}.${Number(match[3]) + 2}`;
const minorVersion = `${match[1]}.${Number(match[2]) + 1}.0`;
const updateOutput = join(resolve(output, '..'), 'release-index-update.json');
const updatePackagesDir = join(resolve(output, '..'), 'update-packages');
// Derive from the sealed base stage (exactly the wanted packages, one version
// each); the registry publisher reads packagesDir.
prepareJourneyUpdatePackages(stage, updatePackagesDir, updateVersion, { publishDir: packagesDir, digestTool: sealer, platformMembers: releaseConfig.platformMembers });
const updateProvenance = writeProvenanceManifest(updatePackagesDir, sourceRevision);
const update = spawnSync(process.execPath, [
  prepareScript,
  '--flow', 'platform',
  '--channel', 'stable',
  '--artifacts-dir', updatePackagesDir,
  '--provenance-manifest', updateProvenance,
  '--binary-manifest', binaryManifestFor(updateVersion),
  '--platform-version', updateVersion,
  '--platform-requires', platformRequires,
  '--platform-adapter-config', adapterConfig,
  '--platform-adapter-options', adapterOptions,
  '--platform-member-packages', platformMembers,
  '--adapter-overrides', adapterOverrides,
  '--registry', packageRegistry,
  '--output', updateOutput,
  ...releaseNotesArgs,
  '--sealer-bin', sealer,
], { stdio: 'inherit' });
if (update.status !== 0) process.exit(update.status ?? 1);

// A direct N-to-N+2 candidate proves that the resolver accepts a matrix-valid
// jump without requiring an intermediate update invocation.
const jumpPackagesDir = join(resolve(output, '..'), 'jump-packages');
prepareJourneyUpdatePackages(stage, jumpPackagesDir, jumpVersion, { publishDir: packagesDir, digestTool: sealer, platformMembers: releaseConfig.platformMembers });
const jumpProvenance = writeProvenanceManifest(jumpPackagesDir, sourceRevision);
const jumpOutput = join(resolve(output, '..'), 'release-index-update-jump.json');
const jumpHistoryArgs = ['--history-index', output, '--history-index', updateOutput];
const jump = spawnSync(process.execPath, [
  prepareScript,
  '--flow', 'platform',
  '--channel', 'stable',
  '--artifacts-dir', jumpPackagesDir,
  '--provenance-manifest', jumpProvenance,
  '--binary-manifest', binaryManifestFor(jumpVersion),
  '--platform-version', jumpVersion,
  '--platform-requires', platformRequires,
  '--platform-adapter-config', adapterConfig,
  '--platform-adapter-options', adapterOptions,
  '--platform-member-packages', platformMembers,
  '--adapter-overrides', adapterOverrides,
  '--registry', packageRegistry,
  '--output', jumpOutput,
  ...releaseNotesArgs,
  ...jumpHistoryArgs,
  '--sealer-bin', sealer,
], { stdio: 'inherit' });
if (jump.status !== 0) process.exit(jump.status ?? 1);

const minorPackagesDir = join(resolve(output, '..'), 'minor-packages');
prepareJourneyUpdatePackages(stage, minorPackagesDir, minorVersion, { publishDir: packagesDir, digestTool: sealer, platformMembers: releaseConfig.platformMembers });
const minorProvenance = writeProvenanceManifest(minorPackagesDir, sourceRevision);
const minorOutput = join(resolve(output, '..'), 'release-index-update-minor.json');
const minor = spawnSync(process.execPath, [
  prepareScript, '--flow', 'platform', '--channel', 'stable',
  '--artifacts-dir', minorPackagesDir, '--provenance-manifest', minorProvenance, '--binary-manifest', binaryManifestFor(minorVersion),
  '--platform-version', minorVersion, '--platform-requires', platformRequires,
  '--platform-adapter-config', adapterConfig, '--platform-adapter-options', adapterOptions,
  '--platform-member-packages', platformMembers, '--adapter-overrides', adapterOverrides,
  '--registry', packageRegistry, '--output', minorOutput, ...releaseNotesArgs, '--sealer-bin', sealer,
], { stdio: 'inherit' });
if (minor.status !== 0) process.exit(minor.status ?? 1);

// This release has a real, sealed gateway artifact whose service entrypoint
// exits non-zero. It exercises recovery after switch and failed host health.
const failedHostVersion = `${match[1]}.${Number(match[2]) + 2}.0`;
const failedHostPackagesDir = join(resolve(output, '..'), 'failed-host-packages');
prepareJourneyUpdatePackages(stage, failedHostPackagesDir, failedHostVersion, {
  publishDir: packagesDir,
  digestTool: sealer,
  platformMembers: releaseConfig.platformMembers,
  failingServicePackage: '@kb-labs/gateway-app',
});
const failedHostProvenance = writeProvenanceManifest(failedHostPackagesDir, sourceRevision);
const failedHostOutput = join(resolve(output, '..'), 'release-index-update-failed-host.json');
const failedHost = spawnSync(process.execPath, [
  prepareScript,
  '--flow', 'platform',
  '--channel', 'stable',
  '--artifacts-dir', failedHostPackagesDir,
  '--provenance-manifest', failedHostProvenance,
  '--binary-manifest', binaryManifestFor(failedHostVersion),
  '--platform-version', failedHostVersion,
  '--platform-requires', platformRequires,
  '--platform-adapter-config', adapterConfig,
  '--platform-adapter-options', adapterOptions,
  '--platform-member-packages', platformMembers,
  '--adapter-overrides', adapterOverrides,
  '--registry', packageRegistry,
  '--output', failedHostOutput,
  ...releaseNotesArgs,
  '--sealer-bin', sealer,
], { stdio: 'inherit' });
if (failedHost.status !== 0) process.exit(failedHost.status ?? 1);

// After proving automatic restore, the journey installs a later healthy
// release and proves the last-healthy root is pruned only after health passes.
const healthyHostVersion = `${match[1]}.${Number(match[2]) + 2}.1`;
const healthyHostPackagesDir = join(resolve(output, '..'), 'healthy-host-packages');
prepareJourneyUpdatePackages(stage, healthyHostPackagesDir, healthyHostVersion, { publishDir: packagesDir, digestTool: sealer, platformMembers: releaseConfig.platformMembers });
const healthyHostProvenance = writeProvenanceManifest(healthyHostPackagesDir, sourceRevision);
const healthyHostOutput = join(resolve(output, '..'), 'release-index-update-healthy-host.json');
const healthyHost = spawnSync(process.execPath, [
  prepareScript,
  '--flow', 'platform',
  '--channel', 'stable',
  '--artifacts-dir', healthyHostPackagesDir,
  '--provenance-manifest', healthyHostProvenance,
  '--binary-manifest', binaryManifestFor(healthyHostVersion),
  '--platform-version', healthyHostVersion,
  '--platform-requires', platformRequires,
  '--platform-adapter-config', adapterConfig,
  '--platform-adapter-options', adapterOptions,
  '--platform-member-packages', platformMembers,
  '--adapter-overrides', adapterOverrides,
  '--registry', packageRegistry,
  '--output', healthyHostOutput,
  ...releaseNotesArgs,
  '--sealer-bin', sealer,
], { stdio: 'inherit' });
if (healthyHost.status !== 0) process.exit(healthyHost.status ?? 1);

// Keep the target-version binary hash valid in the sealed index, then stage a
// corrupted copy at an isolated URL so download verification sees a real
// artifact mismatch.
const badChecksumOutput = join(resolve(output, '..'), 'release-index-update-bad-checksum.json');
const updateBinaryManifest = JSON.parse(readFileSync(binaryManifestFor(updateVersion), 'utf8'));
const badChecksumManifestPath = join(resolve(output, '..'), 'binary-manifests', 'update-bad-checksum.json');
const badChecksumManifest = {
  binaries: updateBinaryManifest.binaries.map(binary => ({
    ...binary,
    // KB_CREATE_DOWNLOAD_BASE_URL resolves binary requests using the final
    // two path segments. Give the corrupt fixture its own route version so it
    // cannot alias the valid /<version>/<filename> asset at the static origin.
    url: `${binaryBaseUrl}/checksum-corrupt/${encodeURIComponent(updateVersion)}-bad-checksum/${binary.filename}`,
  })),
};
writeFileSync(badChecksumManifestPath, `${JSON.stringify(badChecksumManifest, null, 2)}\n`);
const badChecksum = spawnSync(process.execPath, [
  prepareScript,
  '--flow', 'platform',
  '--channel', 'stable',
  '--artifacts-dir', updatePackagesDir,
  '--provenance-manifest', updateProvenance,
  '--binary-manifest', badChecksumManifestPath,
  '--platform-version', updateVersion,
  '--platform-requires', platformRequires,
  '--platform-adapter-config', adapterConfig,
  '--platform-adapter-options', adapterOptions,
  '--platform-member-packages', platformMembers,
  '--adapter-overrides', adapterOverrides,
  '--registry', packageRegistry,
  '--output', badChecksumOutput,
  ...releaseNotesArgs,
  '--sealer-bin', sealer,
], { stdio: 'inherit' });
if (badChecksum.status !== 0) process.exit(badChecksum.status ?? 1);
for (const binary of updateBinaryManifest.binaries) {
  const versionedPath = join(binaryDirectory, 'binaries', updateVersion, binary.filename);
  const basePath = join(binaryDirectory, binary.filename);
  const sourcePath = existsSync(versionedPath) ? versionedPath : basePath;
  const corruptPath = join(resolve(output, '..'), 'checksum-corrupt', `${updateVersion}-bad-checksum`, binary.filename);
  mkdirSync(dirname(corruptPath), { recursive: true });
  const corrupted = readFileSync(sourcePath);
  writeFileSync(corruptPath, Buffer.concat([corrupted, Buffer.from('checksum-corruption')]));
}

const stagedFailureCandidates = [
  {
    key: 'config',
    version: `${match[1]}.${Number(match[2]) + 1}.1`,
    requirement: { id: 'journey.update.requiredConfig', path: '/platform/journey/updateRequired', required: true,
      hint: 'Configure platform.journey.updateRequired before retrying the update.' },
  },
  {
    key: 'doctor',
    version: `${match[1]}.${Number(match[2]) + 1}.2`,
    requirement: { id: 'journey.update.requiredSecret', path: '/platform/journey/updateSecret', required: true,
      secret: true, env: 'KB_JOURNEY_UPDATE_REQUIRED_SECRET', services: ['gateway'],
      hint: 'Configure KB_JOURNEY_UPDATE_REQUIRED_SECRET before retrying the update.' },
  },
];
for (const candidate of stagedFailureCandidates) {
  const candidatePackages = join(resolve(output, '..'), `staged-${candidate.key}-packages`);
  prepareJourneyUpdatePackages(stage, candidatePackages, candidate.version, {
    publishDir: packagesDir,
    digestTool: sealer,
    platformMembers: releaseConfig.platformMembers,
    requiredConfigPackage: '@kb-labs/gateway-app',
    requiredConfig: candidate.requirement,
  });
  const candidateProvenance = writeProvenanceManifest(candidatePackages, sourceRevision);
  const candidateOutput = join(resolve(output, '..'), `release-index-update-${candidate.key}-failure.json`);
  const sealed = spawnSync(process.execPath, [
    prepareScript, '--flow', 'platform', '--channel', 'stable', '--artifacts-dir', candidatePackages,
    '--provenance-manifest', candidateProvenance, '--binary-manifest', binaryManifestFor(candidate.version), '--platform-version', candidate.version,
    '--platform-requires', platformRequires, '--platform-adapter-config', adapterConfig,
    '--platform-adapter-options', adapterOptions, '--platform-member-packages', platformMembers,
    '--adapter-overrides', adapterOverrides, '--registry', packageRegistry,
    '--output', candidateOutput, ...releaseNotesArgs, '--sealer-bin', sealer,
  ], { stdio: 'inherit' });
  if (sealed.status !== 0) process.exit(sealed.status ?? 1);
}

// Re-seal the same runtime and SDK tarballs under a canary prerelease version.
// This is an immutable channel entry with a visible version marker, not a
// rewrite of the installed platform or a resolver shortcut.
const canaryVersion = `${match[1]}.${match[2]}.${Number(match[3]) + 2}-canary.1`;
const canaryPackagesDir = join(resolve(output, '..'), 'canary-packages');
prepareJourneyUpdatePackages(stage, canaryPackagesDir, canaryVersion, { publishDir: packagesDir, digestTool: sealer, platformMembers: releaseConfig.platformMembers });
const canaryProvenance = writeProvenanceManifest(canaryPackagesDir, sourceRevision);
const canaryOutput = join(resolve(output, '..'), 'release-index-canary.json');
const canary = spawnSync(process.execPath, [
  prepareScript,
  '--flow', 'platform',
  '--channel', 'canary',
  '--artifacts-dir', canaryPackagesDir,
  '--provenance-manifest', canaryProvenance,
  '--binary-manifest', binaryManifestFor(canaryVersion),
  '--platform-version', canaryVersion,
  '--platform-requires', platformRequires,
  '--platform-adapter-config', adapterConfig,
  '--platform-adapter-options', adapterOptions,
  '--platform-member-packages', platformMembers,
  '--adapter-overrides', adapterOverrides,
  '--registry', packageRegistry,
  '--output', canaryOutput,
  ...releaseNotesArgs,
  '--sealer-bin', sealer,
], { stdio: 'inherit' });
if (canary.status !== 0) process.exit(canary.status ?? 1);

const binaryTargetVersions = [...new Set([
  binaryVersion,
  updateVersion,
  jumpVersion,
  minorVersion,
  failedHostVersion,
  healthyHostVersion,
  ...stagedFailureCandidates.map(candidate => candidate.version),
  canaryVersion,
])];
writeFileSync(join(resolve(output, '..'), 'journey-binary-target-versions.json'), `${JSON.stringify(binaryTargetVersions, null, 2)}\n`);

function writeProvenanceManifest(directory, revision) {
  const provenance = prepareReleaseProvenance(directory, revision, sealer);
  const path = join(directory, 'provenance.json');
  writeFileSync(path, `${JSON.stringify(provenance, null, 2)}\n`);
  return path;
}
