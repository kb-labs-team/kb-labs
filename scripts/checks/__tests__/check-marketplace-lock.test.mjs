import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkMarketplaceLock } from '../check-marketplace-lock.mjs';

const checker = new URL('../check-marketplace-lock.mjs', import.meta.url);

async function runCheck(lock) {
  const root = await mkdtemp(join(tmpdir(), 'marketplace-lock-check-'));
  try {
    await mkdir(join(root, '.kb'), { recursive: true });
    await writeFile(join(root, '.kb', 'marketplace.lock'), JSON.stringify(lock));
    const issues = await checkMarketplaceLock(root, {
      platformRoot: join(root, 'platform'),
      projectRoot: root,
    });
    return {
      status: issues.length ? 1 : 0,
      stderr: issues.map(item => item.message).join('\n'),
      stdout: issues.length ? '' : 'check-marketplace-lock: OK — marketplace.lock entries use schema v3\n',
      root,
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

test('accepts a v3 project pin without machine paths', async () => {
  const result = await runCheck({
    schema: 'kb.marketplace/3',
    plugins: { '@scope/plugin': { version: '1.2.3', integrity: 'sha512-abc', package: '@scope/plugin', enabled: true, source: 'marketplace', marketplaceSource: 'registry', signatureStatus: 'unsigned' } },
  });
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /schema v3/);
  } finally { await rm(result.root, { recursive: true, force: true }); }
});

test('rejects a v3 marketplace pin without its package name', async () => {
  const result = await runCheck({
    schema: 'kb.marketplace/3',
    plugins: { '@kb-labs/commit': { version: '1.2.3', integrity: 'sha512-abc', enabled: true, source: 'marketplace', marketplaceSource: 'registry', signatureStatus: 'unsigned' } },
  });
  try {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /package must be a valid npm package name/);
  } finally { await rm(result.root, { recursive: true, force: true }); }
});

test('rejects a platform source in a project pin with the runtime scope reason', async () => {
  const result = await runCheck({
    schema: 'kb.marketplace/3',
    plugins: { '@kb-labs/commit': { version: '1.2.3', integrity: 'sha512-abc', package: '@kb-labs/commit', resolvedPath: 'node_modules/@kb-labs/commit', enabled: true, source: 'platform' } },
  });
  try {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /source must be marketplace or local in project locks/);
  } finally { await rm(result.root, { recursive: true, force: true }); }
});

test('rejects malformed integrity with the runtime validation reason and remediation', async () => {
  const result = await runCheck({
    schema: 'kb.marketplace/3',
    plugins: { '@kb-labs/broken': { version: '1.2.3', integrity: 'sha999-invalid', package: '@kb-labs/broken', enabled: true, source: 'marketplace', marketplaceSource: 'registry', signatureStatus: 'unsigned' } },
  });
  try {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /@kb-labs\/broken.*integrity/i);
    assert.match(result.stderr, /kb marketplace sync/);
  } finally { await rm(result.root, { recursive: true, force: true }); }
});

test('reports a v2 lock with the regeneration command', async () => {
  const result = await runCheck({ schema: 'kb.marketplace/2', installed: {} });
  try {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /kb marketplace sync/);
  } finally { await rm(result.root, { recursive: true, force: true }); }
});

test('rejects a machine path in a project pin', async () => {
  const result = await runCheck({
    schema: 'kb.marketplace/3',
    plugins: { demo: { version: '1.0.0', integrity: 'sha512-abc', package: 'demo-entry', enabled: true, source: 'marketplace', marketplaceSource: 'registry', signatureStatus: 'unsigned', resolvedPath: '/machine/store/demo' } },
  });
  try {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /resolvedPath must be a relative path/);
  } finally { await rm(result.root, { recursive: true, force: true }); }
});

test('reports the runtime project-scope rule for adapter sections', async () => {
  const result = await runCheck({ schema: 'kb.marketplace/3', plugins: {}, adapters: {} });
  try {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /project lock must not contain adapters/);
    assert.match(result.stderr, /kb marketplace sync/);
  } finally { await rm(result.root, { recursive: true, force: true }); }
});

test('rejects adapters in a genuine project lock while validating a shared root as platform scope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'marketplace-lock-dual-role-'));
  try {
    await mkdir(join(root, '.kb'), { recursive: true });
    const lock = { schema: 'kb.marketplace/3', plugins: {}, adapters: {} };
    await writeFile(join(root, '.kb', 'marketplace.lock'), JSON.stringify(lock));
    const shared = await checkMarketplaceLock(root, { platformRoot: root, projectRoot: root });
    const project = await checkMarketplaceLock(root, { platformRoot: join(root, 'platform'), projectRoot: root });

    assert.deepEqual(shared, []);
    assert.match(project[0]?.message ?? '', /project lock must not contain adapters/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('reports the runtime project-scope rule for platform plugin entries', async () => {
  const result = await runCheck({
    schema: 'kb.marketplace/3',
    plugins: { '@kb-labs/example': { version: '1.0.0', integrity: 'sha512-abc', package: '@kb-labs/example', resolvedPath: 'node_modules/@kb-labs/example', enabled: true, source: 'platform' } },
  });
  try {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /@kb-labs\/example.*source must be marketplace or local in project locks/);
    assert.match(result.stderr, /kb marketplace sync/);
  } finally { await rm(result.root, { recursive: true, force: true }); }
});

test('accepts the shared workspace lock under platform scope and runtime discovers its adapters', async () => {
  const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const lock = JSON.parse(await readFile(join(workspaceRoot, '.kb', 'marketplace.lock'), 'utf8'));
  const isolatedHome = await mkdtemp(join(tmpdir(), 'marketplace-lock-home-'));
  const env = { ...process.env, HOME: isolatedHome, KB_MARKETPLACE_LOCK_ROOT: workspaceRoot };
  delete env.KB_PLATFORM_ROOT;
  delete env.KB_HOME;
  delete env.KB_NET_OFFSET;
  const result = spawnSync(process.execPath, [checker.pathname], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    env,
  });
  try {
    const { discoverAdapters } = await import(new URL('../../../core/runtime/dist/index.js', import.meta.url));
    const discovered = await discoverAdapters(workspaceRoot);

    assert.ok([...discovered.keys()].every(packageName => Object.hasOwn(lock.adapters ?? {}, packageName)));
    assert.equal(result.status, 0, result.stderr);
    assert.ok(discovered.size > 0, 'platform adapter discovery reads the accepted workspace lock');
  } finally { await rm(isolatedHome, { recursive: true, force: true }); }
});
