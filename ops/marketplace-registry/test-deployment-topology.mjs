#!/usr/bin/env node
// case: S-321.1
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const composeFile = process.env.KB_REGISTRY_COMPOSE_FILE
  ? path.resolve(process.env.KB_REGISTRY_COMPOSE_FILE)
  : path.join(root, 'ops/marketplace-registry/docker-compose.registry.yml');
const result = spawnSync('docker', [
  'compose', '-p', 'registry-topology-test', '-f', composeFile, 'config', '--format', 'json',
], {
  cwd: root,
  encoding: 'utf8',
  env: {
    ...process.env,
    STATE_DAEMON_IMAGE_TAG: 'topology-test',
    MARKETPLACE_REGISTRY_IMAGE_TAG: 'topology-test',
    GATEWAY_IMAGE_TAG: 'topology-test',
    KB_REGISTRY_SIGNING_KEY: 'topology-test-only',
    GATEWAY_INTERNAL_SECRET: 'topology-test-only',
    GATEWAY_JWT_SECRET: 'topology-test-only',
    GATEWAY_BOOTSTRAP_ADMIN_PASSWORD: 'topology-test-only',
  },
});
if (result.error) { throw result.error; }
assert.equal(result.status, 0, result.stderr);

const config = JSON.parse(result.stdout);
const gateway = config.services['kb-gateway'];
const registry = config.services['kb-marketplace-registry'];
const state = config.services['kb-state-daemon'];
assert.deepEqual(Object.keys(gateway.networks).sort(), ['gateway_edge', 'registry_private']);
assert(gateway.ports.some((port) => port.target === 4000 && String(port.published) === '4000' && port.host_ip === '127.0.0.1'));
assert.deepEqual(Object.keys(registry.networks), ['registry_private']);
assert.deepEqual(Object.keys(state.networks), ['registry_private']);
assert.equal(registry.ports?.length ?? 0, 0);
assert.equal(state.ports?.length ?? 0, 0);
assert.equal(config.networks.registry_private.internal, true);
assert.notEqual(config.networks.gateway_edge.internal, true);
process.stdout.write('Marketplace Registry topology is loopback-only and private services remain internal.\n');
