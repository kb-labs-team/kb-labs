import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = new URL('./prepare-release-index.mjs', import.meta.url);

test('prepares a sealed index from staged plugin, service and adapter manifests', () => {
  const root = mkdtempSync(join(tmpdir(), 'kb-release-index-'));
  const stage = join(root, 'stage');
  const packageRoot = join(root, 'packages');
  mkdirSync(stage, { recursive: true });
  const artifacts = [
    packageArtifact(root, packageRoot, stage, '@kb-labs/core-runtime', '2.0.0', ''),
    packageArtifact(root, packageRoot, stage, '@kb-labs/core-contracts', '2.0.0', ''),
    packageArtifact(root, packageRoot, stage, '@kb-labs/sdk', '2.0.0', '', { peerDependencies: { '@kb-labs/core-runtime': '>=2.0.0 <3.0.0' } }),
    packageArtifact(root, packageRoot, stage, '@kb-labs/commit-entry', '2.0.0', JSON.stringify({ schema: 'kb.plugin/3', id: '@kb-labs/commit', version: '2.0.0', platform: { requires: ['cache'] } })),
    // The package name doesn't follow the "-entry" convention, so the catalog
    // ID must come from the manifest's own id, not a package-name heuristic.
    packageArtifact(root, packageRoot, stage, '@kb-labs/release-manager-cli', '2.0.0', JSON.stringify({ schema: 'kb.plugin/3', id: '@kb-labs/release', version: '2.0.0' })),
    packageArtifact(root, packageRoot, stage, '@kb-labs/workflow-daemon', '2.0.0', 'var manifest = { schema: "kb.service/1", id: "workflow", runtime: { port: 7778, healthCheck: "/health" } }; export { manifest };', { bin: { 'kb-workflow': './dist/index.js' } }),
    packageArtifact(root, packageRoot, stage, '@kb-labs/adapters-pino', '2.0.0', 'const manifest={id:"pino-logger",implements:["ILogger"]}; export {manifest};'),
    packageArtifact(root, packageRoot, stage, '@kb-labs/adapters-service-transport-http', '2.0.0', 'const manifest={id:"service-transport-http",implements:["IServiceTransport"]}; export {manifest};'),
    packageArtifact(root, packageRoot, stage, '@kb-labs/adapters-sqlite', '2.0.0', 'const manifest={id:"sqlite",implements:["IKVStore"]}; export {manifest};'),
    packageArtifact(root, packageRoot, stage, '@kb-labs/adapters-openai', '2.0.0', 'const manifest={id:"openai",implements:["ILLM"]}; export {manifest};'),
  ];
  writeFileSync(join(stage, 'manifest.json'), JSON.stringify(artifacts));
  const binaryManifest = join(root, 'binary-manifest.json');
  writeFileSync(binaryManifest, JSON.stringify({ binaries: [{ id: 'kb-create', os: 'linux', arch: 'amd64', url: 'https://example.test/kb-create', filename: 'kb-create-linux-amd64', sha256: 'binary-sha' }] }));
  const output = join(root, 'release-index.json');
  execFileSync(process.execPath, [script.pathname, '--flow', 'platform', '--channel', 'canary', '--artifacts-dir', stage, '--binary-manifest', binaryManifest, '--platform-requires', 'serviceTransport', '--platform-adapter-config', '{"serviceTransport":"@kb-labs/adapters-service-transport-http","kvStore":"@kb-labs/adapters-sqlite/kv","llm":"@kb-labs/adapters-openai"}', '--platform-adapter-options', '{"serviceTransport":{"services":{"workflow":{"url":"http://127.0.0.1:7778"}}},"llm":{"apiKey":"${OPENAI_API_KEY}"}}', '--platform-member-packages', '@kb-labs/core-contracts,@kb-labs/release-manager-cli', '--output', output], { stdio: 'pipe' });
  const index = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(index.schema, 'kb.create.release-index/v2');
  assert.equal(index.compatibility.schema, 'kb.release-compatibility/2');
  assert.deepEqual(index.compatibility.labels.map(({ id, kind, artifactId, version }) => ({ id, kind, artifactId, version })), [
    { id: 'platform@2.0.0', kind: 'platform', artifactId: 'platform', version: '2.0.0' },
    { id: 'sdk@2.0.0', kind: 'sdk', artifactId: 'sdk', version: '2.0.0' },
    { id: 'binary:kb-create@2.0.0:linux/amd64', kind: 'binary', artifactId: 'kb-create', version: '2.0.0' },
  ]);
  assert.deepEqual(index.compatibility.labels[0].requires, [{ label: 'sdk@2.0.0', constraint: '>=2.0.0 <3.0.0' }]);
  assert.equal(index.channels.canary, '2.0.0');
  assert.equal(index.plugins[0].id, 'commit');
  assert.equal(index.plugins.find(p => p.package === '@kb-labs/release-manager-cli')?.id, 'release');
  assert.equal(index.platforms[0].profiles.default.services[0].id, 'workflow');
  assert.equal(index.platforms[0].profiles.default.services[0].command, 'kb-workflow');
  assert.equal(index.platforms[0].profiles.default.services[0].port, 7778);
  assert.equal(index.platforms[0].profiles.default.services[0].healthCheck, '/health');
  assert.deepEqual(index.platforms[0].requires, [{ capability: 'serviceTransport', requiredBy: 'platform' }]);
  assert.deepEqual(index.platforms[0].config, [
    { id: 'platform.adapters', path: '/platform/adapters', default: '{"serviceTransport":"@kb-labs/adapters-service-transport-http"}' },
    { id: 'platform.adapterOptions', path: '/platform/adapterOptions', default: '{"serviceTransport":{"services":{"workflow":{"url":"http://127.0.0.1:7778"}}}}' },
  ]);
  assert.deepEqual(index.platforms[0].members.map(({ package: packageName }) => packageName), ['@kb-labs/workflow-daemon', '@kb-labs/core-contracts', '@kb-labs/release-manager-cli', '@kb-labs/adapters-service-transport-http', '@kb-labs/adapters-sqlite', '@kb-labs/adapters-openai']);
  // Regression coverage for the members[]-id divergence bug: this array used
  // to re-derive each member's catalog id from its package name (falling
  // back to idFor() whenever the package wasn't a staged service or adapter),
  // instead of reusing the same normalizedID already written into that
  // package's own kb-create.manifest.json. For @kb-labs/release-manager-cli
  // that produced "release-manager-cli" here but "release" in the shipped
  // manifest file, so installed.Load()'s id equality check failed at publish
  // time with a misleading "does not match resolved artifact" error.
  assert.equal(index.platforms[0].members.find(m => m.package === '@kb-labs/release-manager-cli')?.id, 'release');
  assert.deepEqual(index.adapters.find(adapter => adapter.id === 'pino-logger')?.provides, ['logger']);
  // Regression coverage for the capability-derivation bug: lowercasing every
  // capital letter in the interface name (instead of just the leading run)
  // turned "IServiceTransport" into "servicetransport" and "IKVStore" into
  // "kvstore", neither of which matched the "serviceTransport"/"kvStore"
  // capabilities the platform actually requires — so no adapter was ever
  // found for them and bootstrap failed with KB_CREATE_PROVIDER_UNRESOLVED.
  assert.deepEqual(index.adapters.find(adapter => adapter.id === 'service-transport-http')?.provides, ['serviceTransport']);
  assert.deepEqual(index.adapters.find(adapter => adapter.id === 'sqlite')?.provides, ['kvStore']);
});

test('fails closed when a configured platform adapter is not staged', () => {
  const root = mkdtempSync(join(tmpdir(), 'kb-release-index-adapter-'));
  const stage = join(root, 'stage');
  const packageRoot = join(root, 'packages');
  mkdirSync(stage, { recursive: true });
  const artifacts = [
    packageArtifact(root, packageRoot, stage, '@kb-labs/core-runtime', '2.0.0', ''),
    packageArtifact(root, packageRoot, stage, '@kb-labs/sdk', '2.0.0', '', { peerDependencies: { '@kb-labs/core-runtime': '^2.0.0' } }),
  ];
  writeFileSync(join(stage, 'manifest.json'), JSON.stringify(artifacts));
  const binaryManifest = join(root, 'binary-manifest.json');
  writeFileSync(binaryManifest, JSON.stringify({ binaries: [{ id: 'kb-create', os: 'linux', arch: 'amd64', url: 'https://example.test/kb-create', filename: 'kb-create-linux-amd64', sha256: 'binary-sha' }] }));
  const result = spawnSync(process.execPath, [script.pathname, '--flow', 'platform', '--artifacts-dir', stage, '--binary-manifest', binaryManifest, '--platform-adapter-config', '{"cache":"@kb-labs/adapters-redis"}', '--output', join(root, 'release-index.json')], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /configured platform adapter @kb-labs\/adapters-redis is absent/);
});

test('fails closed when the SDK rejects the staged platform even in the same major', () => {
  const root = mkdtempSync(join(tmpdir(), 'kb-release-index-incompatible-'));
  const stage = join(root, 'stage');
  const packageRoot = join(root, 'packages');
  mkdirSync(stage, { recursive: true });
  const artifacts = [
    packageArtifact(root, packageRoot, stage, '@kb-labs/core-runtime', '2.155.2', ''),
    packageArtifact(root, packageRoot, stage, '@kb-labs/sdk', '2.155.2', '', { peerDependencies: { '@kb-labs/core-runtime': '<2.150.0' } }),
  ];
  writeFileSync(join(stage, 'manifest.json'), JSON.stringify(artifacts));
  const binaryManifest = join(root, 'binary-manifest.json');
  writeFileSync(binaryManifest, JSON.stringify({ binaries: [{ id: 'kb-create', os: 'linux', arch: 'amd64', url: 'https://example.test/kb-create', filename: 'kb-create-linux-amd64', sha256: 'binary-sha' }] }));
  const output = join(root, 'release-index.json');
  const result = spawnSync(process.execPath, [script.pathname, '--flow', 'platform', '--channel', 'canary', '--artifacts-dir', stage, '--binary-manifest', binaryManifest, '--output', output], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /rejects .*core-runtime@2\.155\.2/);
});

test('fails closed when a required platform member was not staged', () => {
  const root = mkdtempSync(join(tmpdir(), 'kb-release-index-members-'));
  const stage = join(root, 'stage');
  const packageRoot = join(root, 'packages');
  mkdirSync(stage, { recursive: true });
  const artifacts = [
    packageArtifact(root, packageRoot, stage, '@kb-labs/core-runtime', '2.0.0', ''),
    packageArtifact(root, packageRoot, stage, '@kb-labs/sdk', '2.0.0', '', { peerDependencies: { '@kb-labs/core-runtime': '^2.0.0' } }),
  ];
  writeFileSync(join(stage, 'manifest.json'), JSON.stringify(artifacts));
  const binaryManifest = join(root, 'binary-manifest.json');
  writeFileSync(binaryManifest, JSON.stringify({ binaries: [{ id: 'kb-create', os: 'linux', arch: 'amd64', url: 'https://example.test/kb-create', filename: 'kb-create-linux-amd64', sha256: 'binary-sha' }] }));
  const result = spawnSync(process.execPath, [script.pathname, '--flow', 'platform', '--artifacts-dir', stage, '--binary-manifest', binaryManifest, '--platform-member-packages', '@kb-labs/cli-bin', '--output', join(root, 'release-index.json')], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /required platform member @kb-labs\/cli-bin is absent/);
});

test('reads a minified scientific-notation port literal from a compiled service manifest', () => {
  const root = mkdtempSync(join(tmpdir(), 'kb-release-index-port-'));
  const stage = join(root, 'stage');
  const packageRoot = join(root, 'packages');
  mkdirSync(stage, { recursive: true });
  const artifacts = [
    packageArtifact(root, packageRoot, stage, '@kb-labs/core-runtime', '2.0.0', ''),
    packageArtifact(root, packageRoot, stage, '@kb-labs/sdk', '2.0.0', '', { peerDependencies: { '@kb-labs/core-runtime': '>=2.0.0 <3.0.0' } }),
    // esbuild rewrites round numeric literals into scientific notation
    // (4000 -> 4e3) when minifying published dist bundles; the release index
    // must still recover the real port instead of the truncated leading digit.
    packageArtifact(root, packageRoot, stage, '@kb-labs/gateway-app', '2.0.0', 'var manifest = { schema: "kb.service/1", id: "gateway", runtime: { port: 4e3 } }; export { manifest };', { bin: { 'gateway-app': './dist/index.js' } }),
  ];
  writeFileSync(join(stage, 'manifest.json'), JSON.stringify(artifacts));
  const binaryManifest = join(root, 'binary-manifest.json');
  writeFileSync(binaryManifest, JSON.stringify({ binaries: [{ id: 'kb-create', os: 'linux', arch: 'amd64', url: 'https://example.test/kb-create', filename: 'kb-create-linux-amd64', sha256: 'binary-sha' }] }));
  const output = join(root, 'release-index.json');
  execFileSync(process.execPath, [script.pathname, '--flow', 'platform', '--channel', 'canary', '--artifacts-dir', stage, '--binary-manifest', binaryManifest, '--output', output], { stdio: 'pipe' });
  const index = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(index.platforms[0].profiles.default.services[0].id, 'gateway');
  assert.equal(index.platforms[0].profiles.default.services[0].port, 4000);
});

function packageArtifact(root, packageRoot, stage, name, version, manifest, extra = {}, files = {}) {
  const packageDir = join(packageRoot, 'package');
  rmSync(packageDir, { recursive: true, force: true });
  mkdirSync(join(packageDir, 'dist'), { recursive: true });
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name, version, ...extra }));
  if (manifest) {
    writeFileSync(join(packageDir, /^(?:const|var) /.test(manifest) ? 'dist/manifest.js' : 'dist/manifest.json'), manifest);
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
  const root = mkdtempSync(join(tmpdir(), 'kb-release-index-logs-'));
  const stage = join(root, 'stage');
  const packageRoot = join(root, 'packages');
  mkdirSync(stage, { recursive: true });
  const artifacts = [
    packageArtifact(root, packageRoot, stage, '@kb-labs/core-runtime', '2.0.0', ''),
    packageArtifact(root, packageRoot, stage, '@kb-labs/sdk', '2.0.0', '', { peerDependencies: { '@kb-labs/core-runtime': '>=2.0.0 <3.0.0' } }),
    packageArtifact(root, packageRoot, stage, '@kb-labs/workflow-daemon', '2.0.0', 'var manifest = { schema: "kb.service/1", id: "workflow", runtime: { port: 7778, healthCheck: "/health" } }; export { manifest };', { bin: { 'kb-workflow': './dist/index.js' } }),
    packageArtifact(root, packageRoot, stage, '@kb-labs/adapters-pino', '2.0.0', 'const manifest={id:"pino-logger",implements:["ILogger"]}; export {manifest};'),
    packageArtifact(root, packageRoot, stage, '@kb-labs/adapters-log-ringbuffer', '2.0.0', 'const manifest={id:"log-ringbuffer",implements:["ILogRingBuffer"]}; export {manifest};'),
    packageArtifact(root, packageRoot, stage, '@kb-labs/adapters-service-transport-http', '2.0.0', 'const manifest={id:"service-transport-http",implements:["IServiceTransport"]}; export {manifest};'),
    packageArtifact(root, packageRoot, stage, '@kb-labs/adapters-openai', '2.0.0', 'const manifest={id:"openai",implements:["ILLM"]}; export {manifest};'),
  ];
  writeFileSync(join(stage, 'manifest.json'), JSON.stringify(artifacts));
  const binaryManifest = join(root, 'binary-manifest.json');
  writeFileSync(binaryManifest, JSON.stringify({ binaries: [{ id: 'kb-create', os: 'linux', arch: 'amd64', url: 'https://example.test/kb-create', filename: 'kb-create-linux-amd64', sha256: 'binary-sha' }] }));
  const output = join(root, 'release-index.json');
  execFileSync(process.execPath, [script.pathname, '--flow', 'platform', '--channel', 'canary', '--artifacts-dir', stage, '--binary-manifest', binaryManifest, '--platform-requires', 'serviceTransport', '--platform-adapter-config', '{"serviceTransport":"@kb-labs/adapters-service-transport-http","logger":"@kb-labs/adapters-pino","logRingBuffer":"@kb-labs/adapters-log-ringbuffer","llm":"@kb-labs/adapters-openai"}', '--platform-adapter-options', '{"serviceTransport":{"services":{"workflow":{"url":"http://127.0.0.1:7778"}}}}', '--platform-member-packages', '@kb-labs/workflow-daemon', '--output', output], { stdio: 'pipe' });
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

// --- package-declared configuration requirements (kb-create.requirements.json) ---

const GATEWAY_MANIFEST = 'var manifest = { schema: "kb.service/1", id: "gateway", runtime: { port: 4e3, healthCheck: "/health" } }; export { manifest };';

// Runs the release-index preparation for a platform whose only service is a
// gateway-like package shipping the given extra files.
function prepareWithGateway(files) {
  const root = mkdtempSync(join(tmpdir(), 'kb-release-index-requirements-'));
  const stage = join(root, 'stage');
  const packageRoot = join(root, 'packages');
  mkdirSync(stage, { recursive: true });
  const artifacts = [
    packageArtifact(root, packageRoot, stage, '@kb-labs/core-runtime', '2.0.0', ''),
    packageArtifact(root, packageRoot, stage, '@kb-labs/sdk', '2.0.0', '', { peerDependencies: { '@kb-labs/core-runtime': '>=2.0.0 <3.0.0' } }),
    packageArtifact(root, packageRoot, stage, '@kb-labs/gateway-app', '2.0.0', GATEWAY_MANIFEST, { bin: { 'gateway-app': './dist/index.js' } }, files),
  ];
  writeFileSync(join(stage, 'manifest.json'), JSON.stringify(artifacts));
  const binaryManifest = join(root, 'binary-manifest.json');
  writeFileSync(binaryManifest, JSON.stringify({ binaries: [{ id: 'kb-create', os: 'linux', arch: 'amd64', url: 'https://example.test/kb-create', filename: 'kb-create-linux-amd64', sha256: 'binary-sha' }] }));
  const output = join(root, 'release-index.json');
  const result = spawnSync(process.execPath, [script.pathname, '--flow', 'platform', '--channel', 'canary', '--artifacts-dir', stage, '--binary-manifest', binaryManifest, '--output', output], { encoding: 'utf8' });
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

test('a package without a requirements file still gets an empty config (unchanged behaviour)', () => {
  const { result, output } = prepareWithGateway({});
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const member = JSON.parse(readFileSync(output, 'utf8')).platforms[0].members.find(item => item.package === '@kb-labs/gateway-app');
  assert.equal((member.config ?? []).length, 0);
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
});
