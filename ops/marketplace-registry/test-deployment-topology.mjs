#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
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

// case: S-324.1
test('Compose keeps Gateway loopback-only and Registry services internal', () => {
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
});

// case: S-324.6
test('Nginx exposes a query-safe read-only Registry allowlist', () => {
  const nginxConfig = readFileSync(path.join(root, 'ops/marketplace-registry/nginx-api.kblabs.ru.conf'), 'utf8');
  const accessLogFormat = nginxConfig.match(/log_format\s+kb_api_safe\s+'([^']+)'/u)?.[1] ?? '';
  assert.match(accessLogFormat, /\$uri/u, 'access logs must use the query-free normalized path');
  assert.doesNotMatch(accessLogFormat, /\$(?:request_uri|request)(?:\W|$)/u, 'access logs must not include query strings');
  assert.match(nginxConfig, /limit_except GET HEAD \{ deny all; \}/u);
  assert.match(nginxConfig, /limit_req_status 429;/u);
  assert.match(nginxConfig, /limit_conn_status 429;/u);
  assert.match(nginxConfig, /proxy_set_header X-Forwarded-For \$remote_addr;/u);
  assert.match(nginxConfig, /proxy_set_header X-Forwarded-Host "";/u);
  assert.match(nginxConfig, /proxy_set_header Forwarded "";/u);
  assert.match(nginxConfig, /marketplace-registry\/api\/v1\/\(resolve\|packages/u);
  assert.match(nginxConfig, /@\[\^\/\]\+\//u, 'normalized scoped package routes must be allowlisted');
  assert.match(nginxConfig, /location \/ \{\s*return 404;/u, 'unreviewed and write routes must stay closed');
});
