import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPlatformReleaseConfig } from '../kb-create/scripts/platform-release-config.mjs';

const workspaceRoot = fileURLToPath(new URL('../../', import.meta.url));
const producerPath = fileURLToPath(new URL('./generate-platform-image-default.mjs', import.meta.url));
const registryProducerPath = fileURLToPath(new URL('./generate-registry-image-default.mjs', import.meta.url));
const releaseConfigPath = fileURLToPath(new URL('../kb-create/config/platform-release.jsonc', import.meta.url));

// case: S-268.11
test('service image default carries Marketplace sources without selecting Registry adapters', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'kb-image-default-'));
  try {
    const outputPath = path.join(tempRoot, '.kb', 'kb.config.json');
    execFileSync(process.execPath, [producerPath, outputPath], { cwd: workspaceRoot });

    const generated = JSON.parse(await readFile(outputPath, 'utf8'));
    const release = readPlatformReleaseConfig(releaseConfigPath);
    assert.deepEqual(generated.marketplace?.sources, release.marketplaceSources);
    assert.equal(generated.platform?.adapters, undefined, 'service-neutral image defaults do not select adapters');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

// case: S-268.11
test('image default carries the platform data layout used by adapter runtime paths', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'kb-image-layout-'));
  try {
    const outputPath = path.join(tempRoot, '.kb', 'deploy', 'image-default', 'kb.config.json');
    execFileSync(process.execPath, [producerPath, outputPath], { cwd: workspaceRoot });

    const generatedLayout = JSON.parse(await readFile(path.join(path.dirname(outputPath), 'platform-layout.json'), 'utf8'));
    const contractLayout = JSON.parse(await readFile(path.join(workspaceRoot, 'tools/kb-create/v2/contracts/platform-layout.json'), 'utf8'));
    assert.deepEqual(generatedLayout, contractLayout);
    assert.equal(generatedLayout.platformDataRoot.platformPath, '.kb/data');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

// case: S-268.11
test('Registry image gives KB_HOME a writable root under the copied platform data directory', async () => {
  const dockerfile = await readFile(path.join(workspaceRoot, 'services/marketplace-registry/app/Dockerfile'), 'utf8');
  assert.match(dockerfile, /KB_HOME=\/app\/\.kb\/data/);
  assert.match(dockerfile, /mkdir -p \.kb\/data && chown -R kb:nodejs \.kb/);
});

// case: S-268.11
test('Registry baked config gets release adapter bindings while service defaults remain adapter-neutral', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'kb-registry-image-default-'));
  try {
    const registryOutput = path.join(tempRoot, 'registry', 'kb.config.json');
    const serviceOutput = path.join(tempRoot, 'service', 'kb.config.json');
    execFileSync(process.execPath, [registryProducerPath, registryOutput], { cwd: workspaceRoot });
    execFileSync(process.execPath, [producerPath, serviceOutput], { cwd: workspaceRoot });

    const registryConfig = JSON.parse(await readFile(registryOutput, 'utf8'));
    const serviceConfig = JSON.parse(await readFile(serviceOutput, 'utf8'));
    const release = readPlatformReleaseConfig(releaseConfigPath);
    assert.deepEqual(registryConfig.platform?.adapters, release.adapters);
    assert.equal(serviceConfig.platform?.adapters, undefined);
    assert.equal(registryConfig.platform?.adapters.embeddings, '@kb-labs/adapters-openai/embeddings');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
