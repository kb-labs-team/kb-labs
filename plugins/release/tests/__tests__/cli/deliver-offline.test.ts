import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let root = '';
let registry = '';
vi.mock('../../../src/shared/utils.js', () => ({ findRepoRoot: async () => root }));
vi.mock('@kb-labs/sdk', async importOriginal => ({
  ...await importOriginal<typeof import('@kb-labs/sdk')>(),
  useConfig: async () => ({ flows: { platform: { deliveryTargets: { local: { registry, kind: 'test' } } } } }),
  useLoader: () => ({ start() {}, succeed() {}, fail() {} }),
  useLogger: () => ({ info() {}, warn() {}, error() {} }),
  useEnv: () => undefined,
}));
import { createMockContext, mockCLIInput } from '@kb-labs/sdk/testing';
import deliver from '../../../src/cli/commands/deliver.js';
import { createCandidateBundle } from '../../../src/shared/candidate-bundle.js';

afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

it('verifies a candidate dry-run without connecting to an unavailable registry', async () => {
  root = mkdtempSync(join(tmpdir(), 'x254-offline-'));
  const source = join(root, 'source'); const artifacts = join(root, 'artifacts'); const binaries = join(root, 'binaries');
  for (const dir of [source, artifacts, binaries]) mkdirSync(dir);
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'x254-fixture', version: '1.0.0' }));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, npm_config_cache: join(root, 'cache'), npm_config_userconfig: join(root, 'npmrc') };
  delete env.NPM_TOKEN; delete env.NODE_AUTH_TOKEN;
  const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', artifacts], { cwd: source, env, encoding: 'utf8' }));
  const tarball: string = packed[0].filename;
  writeFileSync(join(artifacts, 'manifest.json'), JSON.stringify([{ name: 'x254-fixture', version: '1.0.0', tarball, sha256: createHash('sha256').update(readFileSync(join(artifacts, tarball))).digest('hex') }]));
  writeFileSync(join(binaries, 'executable'), 'binary');
  const releaseIndex = join(root, 'release-index.json');
  writeFileSync(releaseIndex, JSON.stringify({ platforms: [{ id: 'platform', version: '1.0.0' }] }));
  const commit = '1234567890123456789012345678901234567890';
  const provenance = createCandidateBundle({ candidateId: 'test-candidate', commit, flow: 'platform', version: '1.0.0', channel: 'canary', gate: { policy: 'none', result: 'skipped' }, workflowRunId: 'test', artifactsDir: artifacts, outputDir: join(root, 'bundle'), releaseIndexPath: releaseIndex, binariesDir: binaries });
  let connections = 0;
  const server = createServer((_req, res) => { connections++; res.writeHead(404); res.end('{}'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No TCP address');
  registry = `http://127.0.0.1:${address.port}`;
  vi.stubEnv('HOME', root);
  vi.stubEnv('npm_config_cache', join(root, 'cache'));
  vi.stubEnv('npm_config_userconfig', join(root, 'npmrc'));
  vi.stubEnv('NPM_TOKEN', '');
  vi.stubEnv('NODE_AUTH_TOKEN', '');
  let closed = false;
  const execute = () => deliver.execute(createMockContext({ cwd: root }), mockCLIInput({ flags: { flow: 'platform', 'bundle-dir': 'bundle', 'expected-digest': provenance.bundleDigest, 'candidate-id': 'test-candidate', commit, version: '1.0.0', target: 'local', 'dry-run': true, json: true } }));
  try {
    expect(await execute()).toMatchObject({ success: true });
    expect(connections).toBe(0);
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    closed = true;
    expect(await execute()).toMatchObject({ success: true });
  } finally {
    vi.unstubAllEnvs();
    if (!closed) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}, 15000);

it('refuses a sealed candidate with an unreadable package archive', async () => {
  root = mkdtempSync(join(tmpdir(), 'x254-invalid-'));
  const artifacts = join(root, 'artifacts'); const binaries = join(root, 'binaries');
  mkdirSync(artifacts); mkdirSync(binaries);
  const tarball = 'x254-fixture-1.0.0.tgz';
  const bytes = 'not a tarball';
  writeFileSync(join(artifacts, tarball), bytes);
  writeFileSync(join(artifacts, 'manifest.json'), JSON.stringify([{ name: 'x254-fixture', version: '1.0.0', tarball, sha256: createHash('sha256').update(bytes).digest('hex') }]));
  writeFileSync(join(binaries, 'executable'), 'binary');
  const releaseIndex = join(root, 'release-index.json');
  writeFileSync(releaseIndex, JSON.stringify({ platforms: [{ id: 'platform', version: '1.0.0' }] }));
  const commit = '1234567890123456789012345678901234567890';
  const provenance = createCandidateBundle({ candidateId: 'test-candidate', commit, flow: 'platform', version: '1.0.0', channel: 'canary', gate: { policy: 'none', result: 'skipped' }, workflowRunId: 'test', artifactsDir: artifacts, outputDir: join(root, 'bundle'), releaseIndexPath: releaseIndex, binariesDir: binaries });
  registry = 'http://127.0.0.1:1';
  const result = await deliver.execute(createMockContext({ cwd: root }), mockCLIInput({ flags: { flow: 'platform', 'bundle-dir': 'bundle', 'expected-digest': provenance.bundleDigest, 'candidate-id': 'test-candidate', commit, version: '1.0.0', target: 'local', 'dry-run': true, json: true } }));
  expect(result).toMatchObject({ ok: false });
}, 15000);

it.each([
  { name: 'x254-fixture', version: 'invalid' },
  { name: 'Invalid Name', version: '1.0.0' },
])('refuses a sealed npm-unpublishable package $name@$version', async ({ name, version }) => {
  root = mkdtempSync(join(tmpdir(), 'x254-unpublishable-'));
  const packageDir = join(root, 'package'); const artifacts = join(root, 'artifacts'); const binaries = join(root, 'binaries');
  for (const dir of [packageDir, artifacts, binaries]) mkdirSync(dir);
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name, version }));
  const tarball = 'candidate-1.0.0.tgz';
  execFileSync('tar', ['-czf', join(artifacts, tarball), '-C', root, 'package']);
  writeFileSync(join(artifacts, 'manifest.json'), JSON.stringify([{ name, version, tarball, sha256: createHash('sha256').update(readFileSync(join(artifacts, tarball))).digest('hex') }]));
  writeFileSync(join(binaries, 'executable'), 'binary');
  const releaseIndex = join(root, 'release-index.json');
  writeFileSync(releaseIndex, JSON.stringify({ platforms: [{ id: 'platform', version: '1.0.0' }] }));
  const commit = '1234567890123456789012345678901234567890';
  const provenance = createCandidateBundle({ candidateId: 'test-candidate', commit, flow: 'platform', version: '1.0.0', channel: 'canary', gate: { policy: 'none', result: 'skipped' }, workflowRunId: 'test', artifactsDir: artifacts, outputDir: join(root, 'bundle'), releaseIndexPath: releaseIndex, binariesDir: binaries });
  registry = 'http://127.0.0.1:1';
  vi.stubEnv('HOME', root); vi.stubEnv('npm_config_cache', join(root, 'cache')); vi.stubEnv('npm_config_userconfig', join(root, 'npmrc'));
  vi.stubEnv('NPM_TOKEN', ''); vi.stubEnv('NODE_AUTH_TOKEN', '');
  try {
    const result = await deliver.execute(createMockContext({ cwd: root }), mockCLIInput({ flags: { flow: 'platform', 'bundle-dir': 'bundle', 'expected-digest': provenance.bundleDigest, 'candidate-id': 'test-candidate', commit, version: '1.0.0', target: 'local', 'dry-run': true, json: true } }));
    expect(result).toMatchObject({ ok: false });
  } finally { vi.unstubAllEnvs(); }
}, 15000);
