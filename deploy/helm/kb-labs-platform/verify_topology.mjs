#!/usr/bin/env node
// Structural chart checks. Parse the actual chart values, publish matrix, and
// Helm render so image/config drift cannot hide behind source-text matching.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load, loadAll } from 'js-yaml';

try {
  const chart = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(chart, '../../..');
  const workflow = path.join(root, '.github/workflows/publish-platform-images.yml');
  const values = load(readFileSync(path.join(chart, 'values.yaml'), 'utf8'));
  const publish = load(readFileSync(workflow, 'utf8'));
  const publishedImages = new Set(
    publish.jobs.images.strategy.matrix.include.map((entry) => entry.image),
  );
  const services = values.services;
  const enabledImages = new Set(
    Object.values(services).filter((service) => service.enabled).map((service) => service.image),
  );
  const declaredImages = new Set(Object.values(services).map((service) => service.image));
  const expectedImages = new Set([...publishedImages].filter((image) => enabledImages.has(image)));

  const missingPublished = [...declaredImages].filter((image) => !publishedImages.has(image)).sort();
  if (missingPublished.length > 0) {
    throw new Error(`chart service images are not published: ${missingPublished.join(', ')}`);
  }

  const generator = path.join(root, 'tools/release/generate-platform-image-default.mjs');
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'kb-image-default-'));
  try {
    const generatedPath = path.join(temporaryDirectory, 'config.json');
    run('node', [generator, generatedPath], 'release image config generation failed');
    const imageConfig = JSON.parse(readFileSync(generatedPath, 'utf8'));
    if (imageConfig.platform?.deployment?.topology !== 'cloud') {
      throw new Error('release image default topology is not cloud');
    }
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }

  function run(command, args, errorPrefix) {
    const result = spawnSync(command, args, { encoding: 'utf8' });
    if (result.error) throw new Error(`${errorPrefix}: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`${errorPrefix}: ${result.stderr.trim()}`);
    return result.stdout;
  }

  function render(...args) {
    const result = spawnSync('helm', ['template', 'kb-labs-platform', chart, ...args], { encoding: 'utf8' });
    return { stdout: result.stdout, stderr: result.stderr, status: result.status, error: result.error };
  }

  function sameSet(actual, expected) {
    return actual.size === expected.size && [...actual].every((item) => expected.has(item));
  }

  const defaultRender = render('--set', 'image.tag=plan', '--set', 'internalSecretSecretName=plan-secret');
  if (defaultRender.error) throw new Error(`default Helm render failed: ${defaultRender.error.message}`);
  if (defaultRender.status !== 0) throw new Error(`default Helm render failed: ${defaultRender.stderr.trim()}`);
  const documents = loadAll(defaultRender.stdout).filter(Boolean);
  const deployments = documents.filter((resource) => resource.kind === 'Deployment');
  const renderedServices = documents.filter((resource) => resource.kind === 'Service');
  if ([...deployments, ...renderedServices].some(
    (resource) => resource.metadata?.labels?.['app.kubernetes.io/name'] === 'marketplace-registry',
  )) {
    throw new Error('marketplace-registry is rendered by default');
  }
  const renderedServiceNames = new Set(
    renderedServices.map((resource) => resource.metadata?.labels?.['app.kubernetes.io/name']),
  );
  const enabledServiceNames = new Set(
    Object.entries(services).filter(([, service]) => service.enabled).map(([name]) => name),
  );
  if (!sameSet(renderedServiceNames, enabledServiceNames)) {
    throw new Error(
      `default rendered service set differs: expected=${JSON.stringify([...enabledServiceNames].sort())} actual=${JSON.stringify([...renderedServiceNames].sort())}`,
    );
  }
  console.log('[CLAIM] S-267.1 PASS');

  const renderedImages = new Set(
    deployments.flatMap((deployment) => deployment.spec.template.spec.containers.map(
      (container) => container.image.split('/').at(-1).split(':')[0],
    )),
  );
  if (!sameSet(renderedImages, expectedImages)) {
    throw new Error(
      `rendered images differ from published default images: expected=${JSON.stringify([...expectedImages].sort())} actual=${JSON.stringify([...renderedImages].sort())}`,
    );
  }
  console.log('[CLAIM] S-267.2 PASS');

  const composition = documents.find(
    (resource) => resource.kind === 'ConfigMap' && resource.metadata?.name === 'kb-labs-platform-composition',
  );
  if (!composition) throw new Error('default chart must render the topology composition ConfigMap');
  const config = JSON.parse(composition.data['kb.config.override.json']);
  if (config.platform?.deployment?.topology !== 'k8s') throw new Error('rendered deployment topology is not k8s');
  if (config.gateway?.access?.mode !== 'secured') throw new Error('rendered gateway access is not secured');
  if (config.gateway?.auth?.enabled === false) throw new Error('rendered gateway auth is disabled');
  for (const deployment of deployments) {
    const mounts = deployment.spec.template.spec.containers.flatMap((container) => container.volumeMounts ?? []);
    if (!mounts.some((mount) => mount.name === 'composition')) {
      throw new Error(`${deployment.metadata.name} does not mount the topology config`);
    }
  }
  console.log('[CLAIM] S-267.3 PASS');

  for (const override of [
    { gateway: { access: { mode: 'local' } } },
    { gateway: { auth: { enabled: false } } },
  ]) {
    const input = { platform: { deployment: { topology: 'k8s' } }, ...override };
    const refusal = render(
      '--set', 'image.tag=plan',
      '--set', 'internalSecretSecretName=plan-secret',
      '--set-json', `config=${JSON.stringify(input)}`,
    );
    if (refusal.error) throw new Error(`unsecured chart render failed to run: ${refusal.error.message}`);
    if (refusal.status === 0) throw new Error(`unsecured chart render unexpectedly succeeded for ${JSON.stringify(override)}`);
    if (!refusal.stderr.includes('KB_DEPLOYMENT_AUTH_REQUIRED')) {
      throw new Error(`render refusal lacks KB_DEPLOYMENT_AUTH_REQUIRED: ${refusal.stderr.trim()}`);
    }
  }
  console.log('[CLAIM] S-267.4 PASS');
  console.log('helm topology checks: release image cloud default, default service/image set, k8s config mount, and unsecured render refusal passed');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
