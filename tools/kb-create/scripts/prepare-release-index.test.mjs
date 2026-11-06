import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPlatformReleaseConfig, releaseArtifactPackageNames } from './platform-release-config.mjs';
import { invokePackageProvenanceOwner } from './package-provenance.mjs';
import { isPlatformPackage } from '@kb-labs/plugin-runtime';

const script = new URL('./prepare-release-index.mjs', import.meta.url);
const temporaryRoots = new Set();
const temporaryRoot = prefix => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.add(root);
  return root;
};
after(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});
const digestToolDirectory = temporaryRoot('kb-release-index-digest-tool-');
const digestTool = join(digestToolDirectory, 'kb-create-release-index');
execFileSync('go', ['build', '-trimpath', '-o', digestTool, './v2/cmd/kb-create-release-index'], {
  cwd: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
});
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const supportedTargets = JSON.parse(execFileSync(digestTool, ['targets', join(workspaceRoot, '.goreleaser.yaml'), 'kb-create'], { encoding: 'utf8' }));
const schemaFixture = JSON.parse(readFileSync(join(workspaceRoot, 'e2e/platform/fixtures/release-index-v3.json'), 'utf8')).schema;


test('dropping the provenance manifest refuses release-index production', () => {
  const root = temporaryRoot('kb-release-index-required-provenance-');
  const artifacts = join(root, 'artifacts');
  mkdirSync(artifacts, { recursive: true });
  const result = spawnSync(process.execPath, [script.pathname, '--flow', 'platform', '--artifacts-dir', artifacts,
    '--binary-manifest', join(root, 'binary-manifest.json'), '--output', join(root, 'release-index.json')], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--provenance-manifest is required/);
  assert.equal(existsSync(join(root, 'release-index.json')), false);
});

test('prepares a sealed index from staged plugin, service and adapter manifests', () => {
  const root = temporaryRoot('kb-release-index-');
  const stage = join(root, 'stage');
  const packageRoot = join(root, 'packages');
  mkdirSync(stage, { recursive: true });
  const artifacts = [
    packageArtifact(root, packageRoot, stage, '@kb-labs/core-runtime', '2.0.0', ''),
    packageArtifact(root, packageRoot, stage, '@kb-labs/core-contracts', '2.0.0', ''),
    packageArtifact(root, packageRoot, stage, '@kb-labs/scaffold', '2.0.0', ''),
    packageArtifact(root, packageRoot, stage, '@kb-labs/sdk', '2.0.0', '', { dependencies: { '@kb-labs/core-runtime': '>=2.0.0 <3.0.0' } }),
    packageArtifact(root, packageRoot, stage, '@kb-labs/host-app', '2.0.0', '', { bin: { 'kb-host': './dist/bin.js', 'kb-recover': './dist/recover.js' } }),
    packageArtifact(root, packageRoot, stage, '@kb-labs/commit', '2.0.0', JSON.stringify({ schema: 'kb.plugin/3', id: '@kb-labs/commit', version: '2.0.0', platform: { requires: ['cache'] } })),
    // The package name doesn't follow the "-entry" convention, so the catalog
    // ID must come from the manifest's own id, not a package-name heuristic.
    packageArtifact(root, packageRoot, stage, '@kb-labs/release', '2.0.0', JSON.stringify({ schema: 'kb.plugin/3', id: '@kb-labs/release', version: '2.0.0' })),
    packageArtifact(root, packageRoot, stage, '@kb-labs/workflow-daemon', '2.0.0', '{"schema":"kb.service/1","id":"workflow","runtime":{"port":7778,"healthCheck":"/health"}}', { bin: { 'kb-workflow': './dist/index.js' } }),
    packageArtifact(root, packageRoot, stage, '@kb-labs/adapters-pino', '2.0.0', '{"schema":"kb.adapter/1","id":"pino-logger","implements":["ILogger"],"defaultFor":{"logger":[] }}'),
    packageArtifact(root, packageRoot, stage, '@kb-labs/adapters-service-transport-http', '2.0.0', '{"schema":"kb.adapter/1","id":"service-transport-http","implements":["IServiceTransport"]}'),
    packageArtifact(root, packageRoot, stage, '@kb-labs/adapters-sqlite', '2.0.0', '{"schema":"kb.adapter/1","id":"sqlite-stores","implements":["IDocumentDatabase","IKVStore"],"defaultFor":{"documentDatabase":[],"kvStore":["kv"]}}'),
    packageArtifact(root, packageRoot, stage, '@kb-labs/adapters-openai', '2.0.0', '{"schema":"kb.adapter/1","id":"openai","implements":["ILLM"]}'),
  ];
  writeStageManifest(root, packageRoot, stage, artifacts);
  const binaryManifest = join(root, 'binary-manifest.json');
  writeFileSync(binaryManifest, JSON.stringify({ supportedTargets, binaries: [{ id: 'kb-create', version: '2.0.0', os: 'linux', arch: 'amd64', url: 'https://example.test/kb-create', filename: 'kb-create-linux-amd64', sha256: 'binary-sha' }] }));
  const output = join(root, 'release-index.json');
  execFileSync(process.execPath, [script.pathname, '--flow', 'platform', '--channel', 'canary', '--artifacts-dir', stage, ...provenanceArgs(stage), '--binary-manifest', binaryManifest, '--platform-requires', 'serviceTransport', '--platform-adapter-config', '{"serviceTransport":"@kb-labs/adapters-service-transport-http","kvStore":"@kb-labs/adapters-sqlite/kv","llm":"@kb-labs/adapters-openai"}', '--platform-adapter-options', '{"serviceTransport":{"services":{"workflow":{"url":"http://127.0.0.1:7778"}}},"llm":{"apiKey":"${OPENAI_API_KEY}"}}', '--platform-member-packages', '@kb-labs/core-contracts,@kb-labs/scaffold,@kb-labs/release', '--release-notes', 'Candidate release notes from the journey fixture.', '--output', output], { stdio: 'pipe' });
  assert.equal(existsSync(join(stage, 'v2-manifest-root')), false, 'release-index inspection files must stay out of the staged npm artifact directory');
  assert.equal(existsSync(join(stage, 'manifest-export.json')), false, 'release-index input files must stay out of the staged npm artifact directory');
  const index = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(index.schema, schemaFixture);
  assert.equal(index.compatibility.schema, 'kb.release-compatibility/2');
  assert.deepEqual(index.compatibility.labels.map(({ id, kind, artifactId, version }) => ({ id, kind, artifactId, version })), [
    { id: 'platform@2.0.0', kind: 'platform', artifactId: 'platform', version: '2.0.0' },
    { id: 'sdk@2.0.0', kind: 'sdk', artifactId: 'sdk', version: '2.0.0' },
    { id: 'binary:kb-create@2.0.0:linux/amd64', kind: 'binary', artifactId: 'kb-create', version: '2.0.0' },
  ]);
  assert.deepEqual(index.compatibility.labels[0].requires, [{ label: 'sdk@2.0.0', constraint: '>=2.0.0 <3.0.0' }]);
  assert.deepEqual(index.compatibility.labels[2].requires, [{ label: 'platform@2.0.0' }, { label: 'sdk@2.0.0' }]);
  assert.equal(index.channels.canary, '2.0.0');
  assert.equal(index.platforms[0].releaseNotes, 'Candidate release notes from the journey fixture.');
  assert.ok(index.platforms[0].sizeBytes > 0, 'platform bundle must carry its sealed tarball size');
  assert.equal(index.plugins[0].id, '@kb-labs/commit');
  assert.equal(index.plugins.find(p => p.package === '@kb-labs/release')?.id, '@kb-labs/release');
  // The launcher runs the platform as one host process; the index must say how.
  assert.deepEqual(index.platforms[0].host, {
    command: 'node_modules/.bin/kb-host',
    healthUrl: 'http://127.0.0.1:4000/health',
    recover: { command: 'node_modules/.bin/kb-recover' },
  });
  assert.ok(index.platforms[0].members.some(member => member.package === '@kb-labs/host-app'), 'the host package must be installed with the platform');
  assert.equal(index.platforms[0].profiles.default.services[0].id, 'workflow');
  assert.equal(index.platforms[0].profiles.default.services[0].command, 'kb-workflow');
  assert.equal(index.platforms[0].profiles.default.services[0].port, 7778);
  assert.equal(index.platforms[0].profiles.default.services[0].healthCheck, '/health');
  assert.deepEqual(index.platforms[0].profiles.client, {
    profile: 'client',
    platformVersion: index.platforms[0].version,
    services: [],
  });
  assert.deepEqual(index.platforms[0].requires, [{ capability: 'serviceTransport', requiredBy: 'platform' }]);
  assert.deepEqual(index.platforms[0].config, [
    { id: 'platform.adapters', path: '/platform/adapters', default: '{"serviceTransport":"@kb-labs/adapters-service-transport-http"}' },
    { id: 'platform.adapterOptions', path: '/platform/adapterOptions', default: '{"serviceTransport":{"services":{"workflow":{"url":"http://127.0.0.1:7778"}}}}' },
    { id: 'marketplace.sources', path: '/marketplace/sources', default: '[{"kind":"npm","url":"https://registry.npmjs.org"}]' },
  ]);
  assert.deepEqual(index.platforms[0].members.map(({ package: packageName }) => packageName), ['@kb-labs/workflow-daemon', '@kb-labs/host-app', '@kb-labs/core-contracts', '@kb-labs/scaffold', '@kb-labs/release', '@kb-labs/adapters-service-transport-http', '@kb-labs/adapters-sqlite', '@kb-labs/adapters-openai']);
  // Regression coverage for the members[]-id divergence bug: this array used
  // to re-derive each member's catalog id from its package name (falling
  // back to idFor() whenever the package wasn't a staged service or adapter),
  // instead of reusing the same normalizedID already written into that
  // package's own kb-create.manifest.json. For @kb-labs/release
  // that produced "release-manager-cli" here but "release" in the shipped
  // manifest file, so installed.Load()'s id equality check failed at publish
  // time with a misleading "does not match resolved artifact" error.
  assert.equal(index.platforms[0].members.find(m => m.package === '@kb-labs/release')?.id, '@kb-labs/release');
  assert.equal(index.plugins.some(plugin => plugin.package === '@kb-labs/scaffold'), false);
  assert.ok(index.platforms[0].members.every(member => member.sizeBytes > 0), 'members must carry their sealed tarball sizes');
  assert.deepEqual(index.adapters.find(adapter => adapter.id === 'pino-logger')?.provides, ['logger']);
  assert.deepEqual(index.adapters.find(adapter => adapter.id === 'pino-logger')?.defaultFor, ['logger']);
  assert.deepEqual(index.adapters.find(adapter => adapter.id === 'state-broker')?.defaultFor, ['cache']);
  // Regression coverage for the capability-derivation bug: lowercasing every
  // capital letter in the interface name (instead of just the leading run)
  // turned "IServiceTransport" into "servicetransport" and "IKVStore" into
  // "kvstore", neither of which matched the "serviceTransport"/"kvStore"
  // capabilities the platform actually requires — so no adapter was ever
  // found for them and bootstrap failed with KB_INSTALL_PROVIDER_UNRESOLVED.
  assert.deepEqual(index.adapters.find(adapter => adapter.id === 'service-transport-http')?.provides, ['serviceTransport']);
  assert.deepEqual(index.adapters.find(adapter => adapter.id === 'sqlite-stores')?.provides, ['documentDatabase', 'kvStore']);
});

// case: S-214.12
test('seals the runtime range from the packed workspace SDK contract', () => {
  const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const root = temporaryRoot('kb-release-index-workspace-artifacts-');
  const stage = join(root, 'stage');
  const packageRoot = join(root, 'packages');
  mkdirSync(stage, { recursive: true });
  const workspacePackages = JSON.parse(execFileSync('corepack', ['pnpm', '-r', 'list', '--depth', '-1', '--json'], { cwd: workspaceRoot, encoding: 'utf8' }));
  const workspaceByName = new Map(workspacePackages.map(pkg => [
    JSON.parse(readFileSync(join(pkg.path, 'package.json'), 'utf8')).name,
    pkg,
  ]));
  const releaseConfig = readPlatformReleaseConfig(join(workspaceRoot, 'tools/kb-create/config/platform-release.jsonc'));
  const registryManifest = JSON.parse(readFileSync(join(workspaceRoot, 'e2e/platform/registry-manifest.json'), 'utf8'));
  const releasePackageNames = new Set(releaseArtifactPackageNames(registryManifest, releaseConfig.platformMembers));
  const builtManifests = [];
  for (const workspacePackage of workspacePackages) {
    const relativePackagePath = relative(workspaceRoot, workspacePackage.path);
    if (!relativePackagePath.startsWith('adapters/') && !relativePackagePath.startsWith('services/')) continue;
    const packageJSON = JSON.parse(readFileSync(join(workspacePackage.path, 'package.json'), 'utf8'));
    if (!releasePackageNames.has(packageJSON.name)) continue;
    if (!packageJSON.kb?.manifest && !packageJSON.kb?.adapter?.manifest) continue;
    const builtManifestPath = join(workspacePackage.path, 'dist', 'manifest.json');
    assert.ok(
      existsSync(builtManifestPath),
      `${packageJSON.name} built manifest is missing; run ./tools/kb-devkit/kb-devkit run build --packages ${packageJSON.name} before this test`,
    );
    const manifest = JSON.parse(readFileSync(builtManifestPath, 'utf8'));
    builtManifests.push({ packageJSON, manifest });
  }
  const sdkWorkspace = workspaceByName.get('@kb-labs/sdk');
  assert.ok(sdkWorkspace, 'the workspace must include the published SDK package');
  const sdkArtifact = packedWorkspacePackageArtifact(root, stage, sdkWorkspace.path);
  const sdkPackageJSON = sdkArtifact.packageJSON;
  const sdkRequiredDependencies = Object.keys(sdkPackageJSON.dependencies ?? {});
  const version = JSON.parse(readFileSync(join(workspaceRoot, 'core/runtime/package.json'), 'utf8')).version;
  const artifacts = [
    packageArtifact(root, packageRoot, stage, '@kb-labs/core-runtime', version, ''),
    packageArtifact(root, packageRoot, stage, '@kb-labs/host-app', version, '', { bin: { 'kb-host': './dist/bin.js' } }),
    packageArtifact(root, packageRoot, stage, '@kb-labs/commit', '2.0.0', JSON.stringify({ schema: 'kb.plugin/3', id: '@kb-labs/commit', version: '2.0.0' })),
    packageArtifact(root, packageRoot, stage, '@kb-labs/release', '2.0.0', JSON.stringify({ schema: 'kb.plugin/3', id: '@kb-labs/release', version: '2.0.0' })),
    ...builtManifests.map(({ packageJSON, manifest }) => packageArtifact(
      root, packageRoot, stage, packageJSON.name, '2.0.0', JSON.stringify(manifest),
      packageJSON.bin ? { bin: packageJSON.bin } : {},
    )),
    sdkArtifact.artifact,
  ];
  const artifactNames = new Set(artifacts.map(artifact => artifact.name));
  const candidatePackageNames = new Set([
    ...releaseConfig.platformMembers,
    ...registryManifest.core.map(({ name }) => name),
    ...registryManifest.services.map(({ pkg }) => pkg),
    ...registryManifest.plugins.map(({ pkg }) => pkg).filter(packageName => workspaceByName.has(packageName)),
    ...releaseConfig.platformRequires
      .map(slot => releaseConfig.adapters[slot])
      .filter(Boolean)
      .map(adapter => adapter.startsWith('@') ? adapter.split('/').slice(0, 2).join('/') : adapter.split('/')[0]),
  ]);
  for (const workspacePackage of workspacePackages) {
    const relativePackagePath = relative(workspaceRoot, workspacePackage.path);
    if (!relativePackagePath.startsWith('plugins/') && !relativePackagePath.startsWith('adapters/') && !relativePackagePath.startsWith('sdk/')) continue;
    const packageJSON = JSON.parse(readFileSync(join(workspacePackage.path, 'package.json'), 'utf8'));
    if (Object.keys(packageJSON.peerDependencies ?? {}).some(isPlatformPackage)) candidatePackageNames.add(packageJSON.name);
  }
  for (const packageName of candidatePackageNames) {
    if (artifactNames.has(packageName)) continue;
    const workspacePackage = workspaceByName.get(packageName);
    assert.ok(workspacePackage, `candidate package ${packageName} must come from the workspace`);
    const packageJSON = JSON.parse(readFileSync(join(workspacePackage.path, 'package.json'), 'utf8'));
    const packageDist = join(workspacePackage.path, 'dist');
    const files = {};
    if (existsSync(packageDist)) {
      const collectRuntimeFiles = directory => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name);
          if (entry.isDirectory()) collectRuntimeFiles(path);
          else if (/\.(?:c|m)?js$/.test(entry.name)) files[relative(workspacePackage.path, path)] = readFileSync(path, 'utf8');
        }
      };
      collectRuntimeFiles(packageDist);
    }
    const manifestPath = join(packageDist, 'manifest.json');
    const manifestText = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : '';
    artifacts.push(packageArtifact(root, packageRoot, stage, packageName, packageJSON.version, manifestText,
      packageJSON, files));
    artifactNames.add(packageName);
  }
  const stagedNames = new Set(artifacts.map(artifact => artifact.name));
  for (const packageName of sdkRequiredDependencies) {
    if (!packageName.startsWith('@kb-labs/')) continue;
    if (stagedNames.has(packageName)) continue;
    const workspacePackage = workspaceByName.get(packageName);
    assert.ok(workspacePackage, `SDK runtime package ${packageName} must come from the workspace`);
    const packageJSON = JSON.parse(readFileSync(join(workspacePackage.path, 'package.json'), 'utf8'));
    artifacts.push(packageArtifact(root, packageRoot, stage, packageName, packageJSON.version, '', packageJSON));
    stagedNames.add(packageName);
  }
  writeFileSync(join(stage, 'manifest.json'), JSON.stringify(artifacts));
  const binaryManifest = join(root, 'binary-manifest.json');
  writeFileSync(binaryManifest, JSON.stringify({ supportedTargets, binaries: [] }));
  const output = join(root, 'release-index.json');
  execFileSync(process.execPath, [script.pathname, '--flow', 'platform', '--artifacts-dir', stage, ...provenanceArgs(stage),
    '--binary-manifest', binaryManifest,
    '--platform-member-packages', releaseConfig.platformMembers.join(','),
    '--platform-requires', releaseConfig.platformRequires.join(','),
    '--platform-adapter-config', JSON.stringify(releaseConfig.adapters),
    '--output', output], { stdio: 'pipe' });
  const index = JSON.parse(readFileSync(output, 'utf8'));
  const candidateManifests = [...candidatePackageNames].flatMap(packageName => {
    const workspacePackage = workspaceByName.get(packageName);
    if (!workspacePackage) return [];
    const path = join(workspacePackage.path, 'dist', 'manifest.json');
    return existsSync(path) ? [JSON.parse(readFileSync(path, 'utf8'))] : [];
  });
  const expectedServices = [...new Set([
    ...registryManifest.services.map(({ id }) => id),
    ...candidateManifests.filter(manifest => manifest.schema === 'kb.service/1').map(manifest => manifest.id),
  ])].sort();
  const expectedAdapters = [...new Set([
    ...builtManifests.filter(({ manifest }) => manifest.schema === 'kb.adapter/1').map(({ manifest }) => manifest.id),
    ...candidateManifests.filter(manifest => manifest.schema === 'kb.adapter/1').map(manifest => manifest.id),
  ])].sort();
  assert.ok(expectedServices.length > 0, 'the workspace build must stage service manifests');
  assert.ok(expectedAdapters.length > 0, 'the workspace build must stage adapter manifests');
  assert.deepEqual(index.platforms[0].profiles.default.services.map(item => item.id).sort(), expectedServices);
  assert.deepEqual(index.adapters.map(item => item.id).sort(), expectedAdapters);

  const platformLabel = index.compatibility.labels.find(label => label.kind === 'platform');
  assert.deepEqual(platformLabel?.requires, [{
    label: `sdk@${sdkPackageJSON.version}`,
    constraint: sdkPackageJSON.dependencies['@kb-labs/core-runtime'],
  }]);
});

test('filesystem adapter contributes the project storage directory default to the release index', () => {
  const root = temporaryRoot('kb-release-index-fs-storage-');
  const stage = join(root, 'stage');
  const packageRoot = join(root, 'packages');
  mkdirSync(stage, { recursive: true });
  const requirement = {
    id: 'storage.default',
    path: '/platform/adapterOptions/storage',
    default: { baseDir: 'storage' },
    hint: 'Store project data under the platform data root',
  };
  const artifacts = [
    packageArtifact(root, packageRoot, stage, '@kb-labs/core-runtime', '2.0.0', ''),
    packageArtifact(root, packageRoot, stage, '@kb-labs/sdk', '2.0.0', '', { dependencies: { '@kb-labs/core-runtime': '>=2.0.0 <3.0.0' } }),
    packageArtifact(root, packageRoot, stage, '@kb-labs/host-app', '2.0.0', '', { bin: { 'kb-host': './dist/bin.js', 'kb-recover': './dist/recover.js' } }),
    packageArtifact(root, packageRoot, stage, '@kb-labs/adapters-fs', '2.0.0', '{"schema":"kb.adapter/1","id":"fs-storage","implements":"IStorage","defaultFor":{"storage":[] }}', {}, {
      'kb-create.requirements.json': JSON.stringify({ schema: 'kb.create.requirements/v1', requirements: [requirement] }),
    }),
  ];
  writeStageManifest(root, packageRoot, stage, artifacts);
  const binaryManifest = join(root, 'binary-manifest.json');
  writeFileSync(binaryManifest, JSON.stringify({ supportedTargets, binaries: [{ id: 'kb-create', version: '2.0.0', os: 'linux', arch: 'amd64', url: 'https://example.test/kb-create', filename: 'kb-create-linux-amd64', sha256: 'binary-sha' }] }));
  const output = join(root, 'release-index.json');
  execFileSync(process.execPath, [script.pathname, '--flow', 'platform', '--artifacts-dir', stage, ...provenanceArgs(stage), '--binary-manifest', binaryManifest, '--platform-requires', 'storage', '--platform-adapter-config', '{"storage":"@kb-labs/adapters-fs"}', '--output', output], { stdio: 'pipe' });

  const index = JSON.parse(readFileSync(output, 'utf8'));
  const storage = index.adapters.find(adapter => adapter.package === '@kb-labs/adapters-fs');
  assert.deepEqual(storage.defaultFor, ['storage']);
  assert.deepEqual(storage.config, [{ ...requirement, default: JSON.stringify(requirement.default) }]);
  assert.ok(index.platforms[0].members.some(member => member.package === '@kb-labs/adapters-fs'));
});

test('fails closed when a configured platform adapter is not staged', () => {
  const root = temporaryRoot('kb-release-index-adapter-');
  const stage = join(root, 'stage');
  const packageRoot = join(root, 'packages');
  mkdirSync(stage, { recursive: true });
  const artifacts = [
    packageArtifact(root, packageRoot, stage, '@kb-labs/core-runtime', '2.0.0', ''),
    packageArtifact(root, packageRoot, stage, '@kb-labs/sdk', '2.0.0', '', { dependencies: { '@kb-labs/core-runtime': '^2.0.0' } }),
    packageArtifact(root, packageRoot, stage, '@kb-labs/host-app', '2.0.0', '', { bin: { 'kb-host': './dist/bin.js', 'kb-recover': './dist/recover.js' } }),
  ];
  writeStageManifest(root, packageRoot, stage, artifacts);
  const binaryManifest = join(root, 'binary-manifest.json');
  writeFileSync(binaryManifest, JSON.stringify({ supportedTargets, binaries: [{ id: 'kb-create', version: '2.0.0', os: 'linux', arch: 'amd64', url: 'https://example.test/kb-create', filename: 'kb-create-linux-amd64', sha256: 'binary-sha' }] }));
  const result = spawnSync(process.execPath, [script.pathname, '--flow', 'platform', '--artifacts-dir', stage, ...provenanceArgs(stage), '--binary-manifest', binaryManifest, '--platform-adapter-config', '{"cache":"@kb-labs/adapters-redis"}', '--output', join(root, 'release-index.json')], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /configured platform adapter @kb-labs\/adapters-redis is absent/);
});

// case: S-214.12
test('derives the platform compatibility range from the SDK runtime dependency', () => {
  const root = temporaryRoot('kb-release-index-sdk-runtime-dependency-');
  const stage = join(root, 'stage');
  const packageRoot = join(root, 'packages');
  mkdirSync(stage, { recursive: true });
  const artifacts = [
    packageArtifact(root, packageRoot, stage, '@kb-labs/core-runtime', '2.0.0', ''),
    packageArtifact(root, packageRoot, stage, '@kb-labs/sdk', '2.0.0', '', { dependencies: { '@kb-labs/core-runtime': '^2.0.0' } }),
    packageArtifact(root, packageRoot, stage, '@kb-labs/host-app', '2.0.0', '', { bin: { 'kb-host': './dist/bin.js' } }),
  ];
  writeStageManifest(root, packageRoot, stage, artifacts);
  const binaryManifest = join(root, 'binary-manifest.json');
  writeFileSync(binaryManifest, JSON.stringify({ supportedTargets, binaries: [] }));
  const output = join(root, 'release-index.json');
  const result = spawnSync(process.execPath, [script.pathname, '--flow', 'platform', '--artifacts-dir', stage, ...provenanceArgs(stage), '--binary-manifest', binaryManifest, '--output', output], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const index = JSON.parse(readFileSync(output, 'utf8'));
  assert.deepEqual(index.compatibility.labels[0].requires, [{ label: 'sdk@2.0.0', constraint: '^2.0.0' }]);
});

test('records the SDK and platform versions without a second range compatibility gate', () => {
  const root = temporaryRoot('kb-release-index-incompatible-');
  const stage = join(root, 'stage');
  const packageRoot = join(root, 'packages');
  mkdirSync(stage, { recursive: true });
  const artifacts = [
    packageArtifact(root, packageRoot, stage, '@kb-labs/core-runtime', '2.155.2', ''),
    packageArtifact(root, packageRoot, stage, '@kb-labs/sdk', '2.155.2', '', { dependencies: { '@kb-labs/core-runtime': '<2.150.0' } }),
    packageArtifact(root, packageRoot, stage, '@kb-labs/host-app', '2.155.2', '', { bin: { 'kb-host': './dist/bin.js', 'kb-recover': './dist/recover.js' } }),
  ];
  writeStageManifest(root, packageRoot, stage, artifacts);
  const binaryManifest = join(root, 'binary-manifest.json');
  writeFileSync(binaryManifest, JSON.stringify({ supportedTargets, binaries: [{ id: 'kb-create', version: '2.0.0', os: 'linux', arch: 'amd64', url: 'https://example.test/kb-create', filename: 'kb-create-linux-amd64', sha256: 'binary-sha' }] }));
  const output = join(root, 'release-index.json');
  const result = spawnSync(process.execPath, [script.pathname, '--flow', 'platform', '--channel', 'canary', '--artifacts-dir', stage, ...provenanceArgs(stage), '--binary-manifest', binaryManifest, '--output', output], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const index = JSON.parse(readFileSync(output, 'utf8'));
  assert.deepEqual(index.compatibility.labels[0], {
    id: 'platform@2.155.2',
    kind: 'platform',
    artifactId: 'platform',
    version: '2.155.2',
    requires: [{ label: 'sdk@2.155.2', constraint: '<2.150.0' }],
    status: 'prepared',
    validatedBy: ['stage', 'package-manifest', 'artifact-hash', 'sdk-runtime-dependency'],
  });
});

// case: S-179.14
test('each staged plugin must have its declared platform peers provided by the platform graph', () => {
  const root = temporaryRoot('kb-release-index-platform-peer-');
  const stage = join(root, 'stage');
  const packageRoot = join(root, 'packages');
  mkdirSync(stage, { recursive: true });
  const artifacts = [
    packageArtifact(root, packageRoot, stage, '@kb-labs/core-runtime', '2.0.0', ''),
    packageArtifact(root, packageRoot, stage, '@kb-labs/sdk', '2.0.0', '', { dependencies: { '@kb-labs/core-runtime': '^2.0.0' } }),
    packageArtifact(root, packageRoot, stage, '@kb-labs/host-app', '2.0.0', '', { bin: { 'kb-host': './dist/bin.js' } }),
    packageArtifact(root, packageRoot, stage, '@kb-labs/cli-bin', '2.0.0', ''),
    packageArtifact(root, packageRoot, stage, '@kb-labs/workflow-entry', '2.0.0', '', {
      peerDependencies: { '@kb-labs/cli-runtime': '^2.0.0' },
    }),
    packageArtifact(root, packageRoot, stage, '@kb-labs/marketplace-plugin', '2.0.0', '', {
      peerDependencies: { '@kb-labs/cli-runtime': '^2.0.0' },
    }, { 'dist/manifest.json': JSON.stringify({ schema: 'kb.plugin/3', id: '@kb-labs/marketplace-plugin', version: '2.0.0' }) }),
    packageArtifact(root, packageRoot, stage, '@kb-labs/cli-runtime', '2.0.0', ''),
  ];
  writeStageManifest(root, packageRoot, stage, artifacts);
  const binaryManifest = join(root, 'binary-manifest.json');
  writeFileSync(binaryManifest, JSON.stringify({ supportedTargets, binaries: [] }));
  const args = [script.pathname, '--flow', 'platform', '--artifacts-dir', stage, ...provenanceArgs(stage),
    '--binary-manifest', binaryManifest,
    '--platform-member-packages', '@kb-labs/cli-bin,@kb-labs/workflow-entry',
    '--output', join(root, 'release-index.json')];
  const missingPeer = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.notEqual(missingPeer.status, 0);
  assert.match(`${missingPeer.stdout}\n${missingPeer.stderr}`, /declares platform peer @kb-labs\/cli-runtime, which the platform package graph does not provide/);

  args[args.indexOf('--platform-member-packages') + 1] = '@kb-labs/cli-bin,@kb-labs/workflow-entry,@kb-labs/cli-runtime';
  const providedPeer = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(providedPeer.status, 0, `${providedPeer.stdout}\n${providedPeer.stderr}`);
});

test('fails closed when a required platform member was not staged', () => {
  const root = temporaryRoot('kb-release-index-members-');
  const stage = join(root, 'stage');
  const packageRoot = join(root, 'packages');
  mkdirSync(stage, { recursive: true });
  const artifacts = [
    packageArtifact(root, packageRoot, stage, '@kb-labs/core-runtime', '2.0.0', ''),
    packageArtifact(root, packageRoot, stage, '@kb-labs/sdk', '2.0.0', '', { dependencies: { '@kb-labs/core-runtime': '^2.0.0' } }),
    packageArtifact(root, packageRoot, stage, '@kb-labs/host-app', '2.0.0', '', { bin: { 'kb-host': './dist/bin.js', 'kb-recover': './dist/recover.js' } }),
  ];
  writeStageManifest(root, packageRoot, stage, artifacts);
  const binaryManifest = join(root, 'binary-manifest.json');
  writeFileSync(binaryManifest, JSON.stringify({ supportedTargets, binaries: [{ id: 'kb-create', version: '2.0.0', os: 'linux', arch: 'amd64', url: 'https://example.test/kb-create', filename: 'kb-create-linux-amd64', sha256: 'binary-sha' }] }));
  const result = spawnSync(process.execPath, [script.pathname, '--flow', 'platform', '--artifacts-dir', stage, ...provenanceArgs(stage), '--binary-manifest', binaryManifest, '--platform-member-packages', '@kb-labs/cli-bin', '--output', join(root, 'release-index.json')], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /required platform member @kb-labs\/cli-bin is absent/);
});

test('reads the structured service port from the emitted manifest artifact', () => {
  const root = temporaryRoot('kb-release-index-port-');
  const stage = join(root, 'stage');
  const packageRoot = join(root, 'packages');
  mkdirSync(stage, { recursive: true });
  const artifacts = [
    packageArtifact(root, packageRoot, stage, '@kb-labs/core-runtime', '2.0.0', ''),
    packageArtifact(root, packageRoot, stage, '@kb-labs/sdk', '2.0.0', '', { dependencies: { '@kb-labs/core-runtime': '>=2.0.0 <3.0.0' } }),
    packageArtifact(root, packageRoot, stage, '@kb-labs/host-app', '2.0.0', '', { bin: { 'kb-host': './dist/bin.js', 'kb-recover': './dist/recover.js' } }),
    // The JSON artifact preserves the declared numeric port independently of
    // how the corresponding JavaScript bundle is minified.
    packageArtifact(root, packageRoot, stage, '@kb-labs/gateway-app', '2.0.0', '{"schema":"kb.service/1","id":"gateway","runtime":{"port":4000}}', { bin: { 'gateway-app': './dist/index.js' } }),
  ];
  writeStageManifest(root, packageRoot, stage, artifacts);
  const binaryManifest = join(root, 'binary-manifest.json');
  writeFileSync(binaryManifest, JSON.stringify({ supportedTargets, binaries: [{ id: 'kb-create', version: '2.0.0', os: 'linux', arch: 'amd64', url: 'https://example.test/kb-create', filename: 'kb-create-linux-amd64', sha256: 'binary-sha' }] }));
  const output = join(root, 'release-index.json');
  execFileSync(process.execPath, [script.pathname, '--flow', 'platform', '--channel', 'canary', '--artifacts-dir', stage, ...provenanceArgs(stage), '--binary-manifest', binaryManifest, '--output', output], { stdio: 'pipe' });
  const index = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(index.platforms[0].profiles.default.services[0].id, 'gateway');
  assert.equal(index.platforms[0].profiles.default.services[0].port, 4000);
});


function provenanceArgs(stage) {
  const packages = JSON.parse(readFileSync(join(stage, 'manifest.json'), 'utf8'));
  const records = invokePackageProvenanceOwner(digestTool,
    ['provenance', stage, 'test-source-revision'], JSON.stringify(packages));
  const output = join(stage, 'provenance.json');
  writeFileSync(output, JSON.stringify(records));
  return ['--provenance-manifest', output];
}

function writeStageManifest(root, packageRoot, stage, artifacts) {
  const staged = [...artifacts];
  const packages = new Set(staged.map(item => item.name));
  if (!packages.has('@kb-labs/commit')) {
    staged.push(packageArtifact(root, packageRoot, stage, '@kb-labs/commit', '2.0.0', JSON.stringify({ schema: 'kb.plugin/3', id: '@kb-labs/commit', version: '2.0.0', platform: { requires: ['cache'] } })));
  }
  if (!packages.has('@kb-labs/release')) {
    staged.push(packageArtifact(root, packageRoot, stage, '@kb-labs/release', '2.0.0', JSON.stringify({ schema: 'kb.plugin/3', id: '@kb-labs/release', version: '2.0.0' })));
  }
  if (!packages.has('@kb-labs/adapters-state-broker')) {
    staged.push(packageArtifact(root, packageRoot, stage, '@kb-labs/adapters-state-broker', '2.0.0', '{"schema":"kb.adapter/1","id":"state-broker","implements":"ICache","defaultFor":{"cache":[] }}'));
  }
  if (!packages.has('@kb-labs/adapters-sqlite')) {
    staged.push(packageArtifact(root, packageRoot, stage, '@kb-labs/adapters-sqlite', '2.0.0', '{"schema":"kb.adapter/1","id":"sqlite-stores","implements":["IDocumentDatabase","IKVStore"],"defaultFor":{"documentDatabase":[],"kvStore":["kv"]}}'));
  }
  if (!packages.has('@kb-labs/adapters-service-transport-http')) {
    staged.push(packageArtifact(root, packageRoot, stage, '@kb-labs/adapters-service-transport-http', '2.0.0', '{"schema":"kb.adapter/1","id":"service-transport-http","implements":["IServiceTransport"]}'));
  }
  if (!packages.has('@kb-labs/workflow-daemon') && !packages.has('@kb-labs/gateway-app')) {
    staged.push(packageArtifact(root, packageRoot, stage, '@kb-labs/gateway-app', '2.0.0', '{"schema":"kb.service/1","id":"gateway","runtime":{"port":4000,"healthCheck":"/health"}}', { bin: { 'gateway-app': './dist/index.js' } }));
  }
  writeFileSync(join(stage, 'manifest.json'), JSON.stringify(staged));
}

function packedWorkspacePackageArtifact(root, stage, packageDirectory) {
  const packedDirectory = join(root, 'packed');
  mkdirSync(packedDirectory, { recursive: true });
  execFileSync('pnpm', ['pack', '--pack-destination', packedDirectory, '--silent'], { cwd: packageDirectory, stdio: 'pipe' });
  const [packedPath] = readdirSync(packedDirectory).filter(name => name.endsWith('.tgz'));
  assert.ok(packedPath, `pnpm pack produced no package for ${packageDirectory}`);
  const source = join(packedDirectory, packedPath);
  const tarball = join(stage, packedPath);
  copyFileSync(source, tarball);
  const packageJSON = JSON.parse(execFileSync('tar', ['-xOzf', source, 'package/package.json'], { encoding: 'utf8' }));
  const sha256 = execFileSync('shasum', ['-a', '256', tarball], { encoding: 'utf8' }).split(' ')[0];
  return {
    artifact: { name: packageJSON.name, version: packageJSON.version, tarball: packedPath, sha256 },
    packageJSON,
  };
}

function packageArtifact(root, packageRoot, stage, name, version, manifest, extra = {}, files = {}) {
  const packageDir = join(packageRoot, 'package');
  rmSync(packageDir, { recursive: true, force: true });
  mkdirSync(join(packageDir, 'dist'), { recursive: true });
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name, version, ...extra }));
  if (manifest) writeFileSync(join(packageDir, 'dist/manifest.json'), manifest);
  else writeFileSync(join(packageDir, 'dist/index.js'), 'release-index package fixture\n');
  if (name === '@kb-labs/workflow-daemon' || name === '@kb-labs/gateway-app') {
    files = {
      'kb-create.requirements.json': JSON.stringify({ schema: 'kb.create.requirements/v1', requirements: [{ id: 'gateway.access.mode', path: '/gateway/access/mode', default: 'local' }] }),
      ...files,
    };
  }
  for (const [relative, content] of Object.entries(files)) {
    mkdirSync(join(packageDir, relative, '..'), { recursive: true });
    writeFileSync(join(packageDir, relative), content);
  }
  const filename = `${name.split('/').pop()}-${version}.tgz`;
  const tarball = join(stage, filename);
  const result = spawnSync('tar', ['-czf', tarball, '-C', packageRoot, 'package'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const sha256 = execFileSync('shasum', ['-a', '256', tarball], { encoding: 'utf8' }).split(' ')[0];
  return { name, version, tarball: filename, sha256 };
}

test('the default platform.adapters baseline keeps the credential-free logger and ring buffer, but not other configured adapters', () => {
  // A default install must show logs (platform.logs needs a bound log adapter)
  // yet stay portable: kvStore/llm-style adapters need paths, credentials or
  // external services, so they stay packaged-but-unbound.
  const root = temporaryRoot('kb-release-index-logs-');
  const stage = join(root, 'stage');
  const packageRoot = join(root, 'packages');
  mkdirSync(stage, { recursive: true });
  const artifacts = [
    packageArtifact(root, packageRoot, stage, '@kb-labs/core-runtime', '2.0.0', ''),
    packageArtifact(root, packageRoot, stage, '@kb-labs/sdk', '2.0.0', '', { dependencies: { '@kb-labs/core-runtime': '>=2.0.0 <3.0.0' } }),
    packageArtifact(root, packageRoot, stage, '@kb-labs/host-app', '2.0.0', '', { bin: { 'kb-host': './dist/bin.js', 'kb-recover': './dist/recover.js' } }),
    packageArtifact(root, packageRoot, stage, '@kb-labs/workflow-daemon', '2.0.0', '{"schema":"kb.service/1","id":"workflow","runtime":{"port":7778,"healthCheck":"/health"}}', { bin: { 'kb-workflow': './dist/index.js' } }),
    packageArtifact(root, packageRoot, stage, '@kb-labs/adapters-pino', '2.0.0', '{"schema":"kb.adapter/1","id":"pino-logger","implements":["ILogger"]}'),
    packageArtifact(root, packageRoot, stage, '@kb-labs/adapters-log-ringbuffer', '2.0.0', '{"schema":"kb.adapter/1","id":"log-ringbuffer","implements":["ILogRingBuffer"]}'),
    packageArtifact(root, packageRoot, stage, '@kb-labs/adapters-service-transport-http', '2.0.0', '{"schema":"kb.adapter/1","id":"service-transport-http","implements":["IServiceTransport"]}'),
    packageArtifact(root, packageRoot, stage, '@kb-labs/adapters-openai', '2.0.0', '{"schema":"kb.adapter/1","id":"openai","implements":["ILLM"]}'),
  ];
  writeStageManifest(root, packageRoot, stage, artifacts);
  const binaryManifest = join(root, 'binary-manifest.json');
  writeFileSync(binaryManifest, JSON.stringify({ supportedTargets, binaries: [{ id: 'kb-create', version: '2.0.0', os: 'linux', arch: 'amd64', url: 'https://example.test/kb-create', filename: 'kb-create-linux-amd64', sha256: 'binary-sha' }] }));
  const output = join(root, 'release-index.json');
  execFileSync(process.execPath, [script.pathname, '--flow', 'platform', '--channel', 'canary', '--artifacts-dir', stage, ...provenanceArgs(stage), '--binary-manifest', binaryManifest, '--platform-requires', 'serviceTransport,logger,logRingBuffer', '--platform-adapter-config', '{"serviceTransport":"@kb-labs/adapters-service-transport-http","logger":"@kb-labs/adapters-pino","logRingBuffer":"@kb-labs/adapters-log-ringbuffer","llm":"@kb-labs/adapters-openai"}', '--platform-adapter-options', '{"serviceTransport":{"services":{"workflow":{"url":"http://127.0.0.1:7778"}}}}', '--platform-member-packages', '@kb-labs/workflow-daemon', '--output', output], { stdio: 'pipe' });
  const index = JSON.parse(readFileSync(output, 'utf8'));
  const adaptersDefault = JSON.parse(index.platforms[0].config.find(entry => entry.id === 'platform.adapters').default);
  assert.deepEqual(adaptersDefault, {
    serviceTransport: '@kb-labs/adapters-service-transport-http',
    logger: '@kb-labs/adapters-pino',
    logRingBuffer: '@kb-labs/adapters-log-ringbuffer',
  });
  // The excluded adapter is still shipped as a platform member for opt-in.
  assert.ok(index.platforms[0].members.some(member => member.package === '@kb-labs/adapters-openai'));
});

test('the release index requires and binds the persistent fresh-install defaults', () => {
  const root = temporaryRoot('kb-release-index-persistent-defaults-');
  const stage = join(root, 'stage');
  const packageRoot = join(root, 'packages');
  mkdirSync(stage, { recursive: true });
  const artifacts = [
    packageArtifact(root, packageRoot, stage, '@kb-labs/core-runtime', '2.0.0', ''),
    packageArtifact(root, packageRoot, stage, '@kb-labs/sdk', '2.0.0', '', { dependencies: { '@kb-labs/core-runtime': '^2.0.0' } }),
    packageArtifact(root, packageRoot, stage, '@kb-labs/host-app', '2.0.0', '', { bin: { 'kb-host': './dist/bin.js', 'kb-recover': './dist/recover.js' } }),
    packageArtifact(root, packageRoot, stage, '@kb-labs/adapters-fs', '2.0.0', '{"schema":"kb.adapter/1","id":"fs","implements":"IStorage","defaultFor":{"storage":[] }}'),
    packageArtifact(root, packageRoot, stage, '@kb-labs/adapters-state-broker', '2.0.0', '{"schema":"kb.adapter/1","id":"state-broker","implements":"ICache","defaultFor":{"cache":[] }}'),
    packageArtifact(root, packageRoot, stage, '@kb-labs/adapters-eventbus-cache', '2.0.0', '{"schema":"kb.adapter/1","id":"eventbus-cache","implements":"IEventBus"}'),
    packageArtifact(root, packageRoot, stage, '@kb-labs/adapters-sqlite', '2.0.0', '{"schema":"kb.adapter/1","id":"sqlite-stores","implements":["IDocumentDatabase","IKVStore"],"defaultFor":{"documentDatabase":[],"kvStore":["kv"]}}'),
    packageArtifact(root, packageRoot, stage, '@kb-labs/adapters-analytics-sqlite', '2.0.0', '{"schema":"kb.adapter/1","id":"analytics","implements":"IAnalytics","defaultFor":{"analytics":[] }}'),
    packageArtifact(root, packageRoot, stage, '@kb-labs/adapters-openai', '2.0.0', '{"schema":"kb.adapter/1","id":"openai-llm","implements":"ILLM","defaultFor":{"llm":["llm"] }}'),
  ];
  writeStageManifest(root, packageRoot, stage, artifacts);
  const binaryManifest = join(root, 'binary-manifest.json');
  writeFileSync(binaryManifest, JSON.stringify({ supportedTargets, binaries: [] }));
  const bindings = {
    storage: '@kb-labs/adapters-fs', cache: '@kb-labs/adapters-state-broker',
    eventBus: '@kb-labs/adapters-eventbus-cache',
    documentDatabase: '@kb-labs/adapters-sqlite', kvStore: '@kb-labs/adapters-sqlite/kv',
    analytics: '@kb-labs/adapters-analytics-sqlite',
  };
  const options = {
    storage: { baseDir: 'storage' },
    documentDatabase: { filename: 'database/kb.sqlite' },
    kvStore: { filename: 'database/kb.sqlite' },
    analytics: { dbPath: 'analytics/analytics.sqlite' },
  };
  const output = join(root, 'release-index.json');
  execFileSync(process.execPath, [script.pathname, '--flow', 'platform', '--artifacts-dir', stage, ...provenanceArgs(stage),
    '--binary-manifest', binaryManifest,
    '--platform-requires', [...Object.keys(bindings), 'llm'].join(','),
    '--platform-adapter-config', JSON.stringify(bindings),
    '--platform-adapter-options', JSON.stringify(options), '--output', output], { stdio: 'pipe' });
  const index = JSON.parse(readFileSync(output, 'utf8'));
  assert.deepEqual(index.platforms[0].requires.map(({ capability }) => capability).sort(), [...Object.keys(bindings), 'llm'].sort());
  assert.deepEqual(JSON.parse(index.platforms[0].config.find(item => item.id === 'platform.adapters').default), bindings);
  assert.deepEqual(JSON.parse(index.platforms[0].config.find(item => item.id === 'platform.adapterOptions').default), options);
  assert.deepEqual(index.adapters.find(adapter => adapter.id === 'openai-llm')?.defaultFor, ['llm']);
});

// --- package-declared configuration requirements (kb-create.requirements.json) ---

const GATEWAY_MANIFEST = '{"schema":"kb.service/1","id":"gateway","runtime":{"port":4000,"healthCheck":"/health"}}';

// Runs the release-index preparation for a platform whose only service is a
// gateway-like package shipping the given extra files.
function prepareWithGateway(files) {
  const root = temporaryRoot('kb-release-index-requirements-');
  const stage = join(root, 'stage');
  const packageRoot = join(root, 'packages');
  mkdirSync(stage, { recursive: true });
  const artifacts = [
    packageArtifact(root, packageRoot, stage, '@kb-labs/core-runtime', '2.0.0', ''),
    packageArtifact(root, packageRoot, stage, '@kb-labs/sdk', '2.0.0', '', { dependencies: { '@kb-labs/core-runtime': '>=2.0.0 <3.0.0' } }),
    packageArtifact(root, packageRoot, stage, '@kb-labs/host-app', '2.0.0', '', { bin: { 'kb-host': './dist/bin.js', 'kb-recover': './dist/recover.js' } }),
    packageArtifact(root, packageRoot, stage, '@kb-labs/gateway-app', '2.0.0', GATEWAY_MANIFEST, { bin: { 'gateway-app': './dist/index.js' } }, files),
  ];
  writeStageManifest(root, packageRoot, stage, artifacts);
  const binaryManifest = join(root, 'binary-manifest.json');
  writeFileSync(binaryManifest, JSON.stringify({ supportedTargets, binaries: [{ id: 'kb-create', version: '2.0.0', os: 'linux', arch: 'amd64', url: 'https://example.test/kb-create', filename: 'kb-create-linux-amd64', sha256: 'binary-sha' }] }));
  const output = join(root, 'release-index.json');
  const result = spawnSync(process.execPath, [script.pathname, '--flow', 'platform', '--channel', 'canary', '--artifacts-dir', stage, ...provenanceArgs(stage), '--binary-manifest', binaryManifest, '--output', output], { encoding: 'utf8' });
  return { result, output, text: `${result.stdout}\n${result.stderr}` };
}

const requirementsFile = requirements => JSON.stringify({ schema: 'kb.create.requirements/v1', requirements });

const GATEWAY_REQUIREMENTS = [
  // `default` is a plain JSON value here; the sealed index carries it as a JSON literal string.
  { id: 'gateway.access.mode', path: '/gateway/access/mode', default: 'secured' },
  { id: 'gateway.bootstrap.adminEmail', path: '/gateway/auth/bootstrap/adminEmail' },
  { id: 'gateway.bootstrap.password', secret: true, env: 'GATEWAY_BOOTSTRAP_ADMIN_PASSWORD', services: ['gateway'], hint: 'admin password' },
];

test('a service package can declare configuration requirements without losing its service graph', () => {
  const { result, output } = prepareWithGateway({ 'kb-create.requirements.json': requirementsFile(GATEWAY_REQUIREMENTS) });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const index = JSON.parse(readFileSync(output, 'utf8'));
  // The regression this guards: naming the file kb-create.manifest.json would
  // make it the primary manifest and drop the service below.
  const service = index.platforms[0].profiles.default.services[0];
  assert.equal(service.id, 'gateway');
  assert.equal(service.port, 4000);
  const member = index.platforms[0].members.find(item => item.package === '@kb-labs/gateway-app');
  assert.deepEqual(member.config.map(item => item.id), ['gateway.access.mode', 'gateway.bootstrap.adminEmail', 'gateway.bootstrap.password']);
  const mode = member.config.find(item => item.id === 'gateway.access.mode');
  assert.equal(mode.path, '/gateway/access/mode');
  assert.equal(mode.default, '"secured"');
  const password = member.config.find(item => item.id === 'gateway.bootstrap.password');
  assert.equal(password.secret, true);
  assert.equal(password.env, 'GATEWAY_BOOTSTRAP_ADMIN_PASSWORD');
  assert.deepEqual(password.services, ['gateway']);
  assert.equal(password.default, undefined, 'a secret never carries a default');
});

test('the requirements file is also honoured when shipped under dist/', () => {
  const { result, output } = prepareWithGateway({ 'dist/kb-create.requirements.json': requirementsFile(GATEWAY_REQUIREMENTS.slice(0, 1)) });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const member = JSON.parse(readFileSync(output, 'utf8')).platforms[0].members.find(item => item.package === '@kb-labs/gateway-app');
  assert.deepEqual(member.config.map(item => item.id), ['gateway.access.mode']);
});

test('seals optional secret severity and action metadata for doctor warnings', () => {
  const requirement = {
    id: 'openai.apiKey', path: '/platform/adapterOptions/llm/apiKey', secret: true,
    required: true, optional: true, severity: 'warning', env: 'OPENAI_API_KEY',
    services: ['gateway'], action: 'set OPENAI_API_KEY to enable LLM features',
  };
  const { result, output } = prepareWithGateway({ 'kb-create.requirements.json': requirementsFile([...GATEWAY_REQUIREMENTS, requirement]) });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const index = JSON.parse(readFileSync(output, 'utf8'));
  const member = index.platforms[0].members.find(item => item.package === '@kb-labs/gateway-app');
  assert.deepEqual(member.config.find(item => item.id === requirement.id), requirement);
});

test('the candidate release declares the config required by the built-in install scenario', () => {
  const { result, output } = prepareWithGateway({});
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const member = JSON.parse(readFileSync(output, 'utf8')).platforms[0].members.find(item => item.package === '@kb-labs/gateway-app');
  assert.deepEqual(member.config.map(item => item.id), ['gateway.access.mode']);
});

test('fails closed on a malformed requirements file rather than shipping the package without them', () => {
  for (const [label, content, message] of [
    ['not JSON', '{oops', /unreadable kb-create\.requirements\.json/],
    ['wrong schema', JSON.stringify({ schema: 'something/else', requirements: [] }), /invalid kb-create\.requirements\.json/],
    ['requirements not an array', JSON.stringify({ schema: 'kb.create.requirements/v1', requirements: {} }), /invalid kb-create\.requirements\.json/],
    ['missing id', requirementsFile([{ path: '/x' }]), /requirement without an id/],
    ['duplicate id', requirementsFile([{ id: 'a', path: '/a' }, { id: 'a', path: '/b' }]), /more than once/],
  ]) {
    const { result, text } = prepareWithGateway({ 'kb-create.requirements.json': content });
    assert.notEqual(result.status, 0, `${label} must fail`);
    assert.match(text, message, label);
  }
});

test('the sealer rejects a secret requirement that cannot reach a service', () => {
  const { result, text } = prepareWithGateway({ 'kb-create.requirements.json': requirementsFile([{ id: 'gateway.jwt', secret: true }]) });
  assert.notEqual(result.status, 0);
  assert.match(text, /secret manifest requirement gateway\.jwt must declare env and services/);
  const output = text.slice(text.indexOf('{')).split(/\r?\n/, 1)[0];
  const failure = JSON.parse(output).error;
  assert.equal(failure.code, 'KB_RELEASE_INDEX_SEAL_FAILED');
  assert.match(failure.cause, /secret manifest requirement gateway\.jwt must declare env and services/);
  assert.equal(failure.details.gate, 'manifest validation');
  assert.match(failure.details.rule, /secret manifest requirement gateway\.jwt must declare env and services/);
  assert.equal(failure.retryable, false);
  assert.match(failure.hint, /gateway\.jwt/i);
  assert.match(failure.hint, /env.*services.*release-index preparation/i);
});

test('the sealer gives a secret default rule its own remediation hint', () => {
  const { result, text } = prepareWithGateway({ 'kb-create.requirements.json': requirementsFile([{
    id: 'gateway.jwt', secret: true, env: 'GATEWAY_JWT', services: ['gateway'], default: '"unsafe"',
  }]) });
  assert.notEqual(result.status, 0);
  assert.match(text, /secret manifest requirement gateway\.jwt must not declare a default/);
  const output = text.slice(text.indexOf('{')).split(/\r?\n/, 1)[0];
  const failure = JSON.parse(output).error;
  assert.equal(failure.code, 'KB_RELEASE_INDEX_SEAL_FAILED');
  assert.equal(failure.details.gate, 'manifest validation');
  assert.match(failure.details.rule, /must not declare a default/);
  assert.equal(failure.retryable, false);
  assert.match(failure.hint, /remove the default/i);
  assert.doesNotMatch(failure.hint, /add.*env.*services/i);
});

function versionFixture(prefix, sdkVersion) {
  const root = temporaryRoot(prefix);
  const stage = join(root, 'stage');
  const packageRoot = join(root, 'packages');
  mkdirSync(stage, { recursive: true });
  writeStageManifest(root, packageRoot, stage, [
    packageArtifact(root, packageRoot, stage, '@kb-labs/core-runtime', '2.0.0', ''),
    packageArtifact(root, packageRoot, stage, '@kb-labs/sdk', sdkVersion, '', { dependencies: { '@kb-labs/core-runtime': '>=2.0.0 <3.0.0' } }),
    packageArtifact(root, packageRoot, stage, '@kb-labs/host-app', '2.0.0', '', { bin: { 'kb-host': './dist/bin.js' } }),
  ]);
  const binaryManifest = join(root, 'binary-manifest.json');
  writeFileSync(binaryManifest, JSON.stringify({ supportedTargets, binaries: [{ id: 'kb-create', version: '2.0.0', os: 'linux', arch: 'amd64', url: 'https://example.test/kb-create', filename: 'kb-create-linux-amd64', sha256: 'binary-sha' }] }));
  const output = join(root, 'release-index.json');
  const base = [script.pathname, '--flow', 'platform', '--artifacts-dir', stage, ...provenanceArgs(stage), '--binary-manifest', binaryManifest, '--output', output];
  return { base, output };
}

// case: S-214.8
test('fails preparation when a staged package declares a manifest but lacks the emitted artifact', () => {
  const root = temporaryRoot('kb-release-index-missing-manifest-artifact-');
  const stage = join(root, 'stage');
  const packageRoot = join(root, 'packages');
  mkdirSync(stage, { recursive: true });
  const artifacts = [
    packageArtifact(root, packageRoot, stage, '@kb-labs/core-runtime', '2.0.0', ''),
    packageArtifact(root, packageRoot, stage, '@kb-labs/sdk', '2.0.0', '', { dependencies: { '@kb-labs/core-runtime': '^2.0.0' } }),
    packageArtifact(root, packageRoot, stage, '@kb-labs/host-app', '2.0.0', '', { bin: { 'kb-host': './dist/bin.js' } }),
    packageArtifact(root, packageRoot, stage, '@kb-labs/adapters-missing-artifact', '2.0.0', '', { kb: { adapter: { manifest: './dist/manifest.js' } } }),
  ];
  writeStageManifest(root, packageRoot, stage, artifacts);
  const binaryManifest = join(root, 'binary-manifest.json');
  writeFileSync(binaryManifest, JSON.stringify({ supportedTargets, binaries: [] }));
  const result = spawnSync(process.execPath, [script.pathname, '--flow', 'platform', '--artifacts-dir', stage, ...provenanceArgs(stage), '--binary-manifest', binaryManifest, '--output', join(root, 'release-index.json')], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /@kb-labs\/adapters-missing-artifact declares kb\.adapter\.manifest but its build did not emit dist\/manifest\.json/);
});

test('writes the actual SDK and binary versions as explicit compatibility relations', () => {
  const { base, output } = versionFixture('kb-release-index-independent-', '2.1.0');
  const binaryManifest = base[base.indexOf('--binary-manifest') + 1];
  writeFileSync(binaryManifest, JSON.stringify({ supportedTargets, binaries: [{ id: 'kb-create', version: '3.0.0', os: 'linux', arch: 'amd64', url: 'https://example.test/kb-create', filename: 'kb-create-linux-amd64', sha256: 'binary-sha' }] }));
  const result = spawnSync(process.execPath, base, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const index = JSON.parse(readFileSync(output, 'utf8'));
  const labels = index.compatibility.labels;
  assert.ok(labels.some(label => label.id === 'platform@2.0.0' && label.requires.some(relation => relation.label === 'sdk@2.1.0')));
  assert.ok(labels.some(label => label.id === 'binary:kb-create@3.0.0:linux/amd64' && label.version === '3.0.0'));
});

test('writes minLauncherVersion on the platform entry only when requested', () => {
  const { base, output } = versionFixture('kb-release-index-minlauncher-', '2.0.0');
  execFileSync(process.execPath, base, { stdio: 'pipe' });
  assert.equal('minLauncherVersion' in JSON.parse(readFileSync(output, 'utf8')).platforms[0], false);
  const withMinimum = spawnSync(process.execPath, [...base, '--min-launcher-version', '2.0.0'], { encoding: 'utf8' });
  assert.notEqual(withMinimum.status, 0);
  assert.match(JSON.parse(withMinimum.stderr.split('\n')[0]).error.cause, /Launcher version \"\" is not a valid semantic version/);
  const exported = JSON.parse(readFileSync(join(dirname(output), 'manifest-export.json'), 'utf8'));
  assert.equal(exported.platforms[0].minLauncherVersion, '2.0.0');
});

test('declares no recovery tool when the host package does not ship one', () => {
  const { root, stage } = hostFixture({ bin: { 'kb-host': './dist/bin.js' } });
  const output = join(root, 'release-index.json');
  execFileSync(process.execPath, [script.pathname, '--flow', 'platform', '--artifacts-dir', stage, ...provenanceArgs(stage), '--binary-manifest', join(root, 'binary-manifest.json'), '--output', output], { stdio: 'pipe' });
  const { host } = JSON.parse(readFileSync(output, 'utf8')).platforms[0];
  assert.deepEqual(host, { command: 'node_modules/.bin/kb-host', healthUrl: 'http://127.0.0.1:4000/health' });
});

test('takes the host health endpoint from the release, not from the launcher', () => {
  const { root, stage } = hostFixture({ bin: { 'kb-host': './dist/bin.js' } });
  const output = join(root, 'release-index.json');
  execFileSync(process.execPath, [script.pathname, '--flow', 'platform', '--artifacts-dir', stage, ...provenanceArgs(stage), '--binary-manifest', join(root, 'binary-manifest.json'), '--host-health-url', 'http://127.0.0.1:4100/health', '--output', output], { stdio: 'pipe' });
  assert.equal(JSON.parse(readFileSync(output, 'utf8')).platforms[0].host.healthUrl, 'http://127.0.0.1:4100/health');
});

test('fails closed when the host package is not staged or has no kb-host executable', () => {
  for (const [hostExtra, expected] of [[undefined, /host package @kb-labs\/host-app is absent/], [{ bin: { other: './x.js' } }, /must declare a kb-host executable/]]) {
    const { root, stage } = hostFixture(hostExtra);
    const result = spawnSync(process.execPath, [script.pathname, '--flow', 'platform', '--artifacts-dir', stage, ...provenanceArgs(stage), '--binary-manifest', join(root, 'binary-manifest.json'), '--output', join(root, 'release-index.json')], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}
${result.stderr}`, expected);
  }
});

// A minimal platform stage; the host package is added only when hostExtra is given.
function hostFixture(hostExtra) {
  const root = temporaryRoot('kb-release-index-host-');
  const stage = join(root, 'stage');
  const packageRoot = join(root, 'packages');
  mkdirSync(stage, { recursive: true });
  const artifacts = [
    packageArtifact(root, packageRoot, stage, '@kb-labs/core-runtime', '2.0.0', ''),
    packageArtifact(root, packageRoot, stage, '@kb-labs/sdk', '2.0.0', '', { dependencies: { '@kb-labs/core-runtime': '>=2.0.0 <3.0.0' } }),
    ...(hostExtra ? [packageArtifact(root, packageRoot, stage, '@kb-labs/host-app', '2.0.0', '', hostExtra)] : []),
  ];
  writeStageManifest(root, packageRoot, stage, artifacts);
  writeFileSync(join(root, 'binary-manifest.json'), JSON.stringify({ supportedTargets, binaries: [{ id: 'kb-create', version: '2.0.0', os: 'linux', arch: 'amd64', url: 'https://example.test/kb-create', filename: 'kb-create-linux-amd64', sha256: 'binary-sha' }] }));
  return { root, stage };
}
