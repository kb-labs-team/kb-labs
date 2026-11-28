import test from 'node:test';
import assert from 'node:assert/strict';
import { registryInstallConfig } from './registry-install-config.mjs';

test('Registry config declares only source settings and manifest-ID values without changing the saved plan', () => {
  const input = { ok: true, data: { plan: {
    host: { healthUrl: 'http://127.0.0.1:4317/health' },
    request: { schema: 'kb.create/v2', secretInputs: ['gateway.bootstrap.password'], values: { existing: 'value' } },
  } } };
  const result = registryInstallConfig(input, 'http://marketplace-registry:5071');
  assert.equal(result.marketplaceSources.registryUrl, 'http://127.0.0.1:4317/api/v1/marketplace-registry');
  assert.equal(result.marketplaceSources.npmUrl, 'http://verdaccio:4873');
  assert.equal(result.marketplaceSources.signingPublicKeyEnv, 'KB_E2E_REGISTRY_PUBLIC_KEY');
  assert.deepEqual(result.secretInputs, ['gateway.internalSecret']);
  assert.deepEqual(result.serviceTransportURLs, { 'marketplace-registry': 'http://marketplace-registry:5071' });
  assert.deepEqual(result.values['gateway.marketplaceRegistryRoute'], { serviceId: 'marketplace-registry', prefix: '/api/v1/marketplace-registry', rewritePrefix: '' });
  assert.equal(result.values['platform.adapterOptions'], undefined);
  assert.equal(input.data.plan.request.marketplaceSources, undefined);
  assert.deepEqual(input.data.plan.request.values, { existing: 'value' });
});

test('rejects an invalid plan before writing config', () => {
  assert.throws(() => registryInstallConfig({ ok: false }, 'http://marketplace-registry:5071'));
  assert.throws(() => registryInstallConfig({ ok: true, data: { plan: { host: { healthUrl: 'not-a-url' }, request: {} } } }, 'http://marketplace-registry:5071'));
});
