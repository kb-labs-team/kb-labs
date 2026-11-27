import test from 'node:test';
import assert from 'node:assert/strict';
import { registryInstallRequest } from './registry-install-request.mjs';

test('Registry request preserves the resolved plan and injects only the supported route and transport', () => {
  const input = { ok: true, data: { plan: {
    host: { healthUrl: 'http://127.0.0.1:4317/health' },
    request: { schema: 'kb.create/v2', secretInputs: ['gateway.bootstrap.password'], values: { existing: 'value' } },
    configPatches: [{ path: '/platform/adapterOptions', json: JSON.stringify({ serviceTransport: { services: { marketplace: { url: 'http://127.0.0.1:5070' } } } }) }],
  } } };
  const result = registryInstallRequest(input, 'http://marketplace-registry:5071');
  assert.equal(result.marketplaceSources.registryUrl, 'http://127.0.0.1:4317/api/v1/marketplace-registry');
  assert.equal(result.marketplaceSources.npmUrl, 'http://verdaccio:4873');
  assert.equal(result.marketplaceSources.signingPublicKeyEnv, 'KB_E2E_REGISTRY_PUBLIC_KEY');
  assert.equal(result.gatewayUrl, 'http://127.0.0.1:4317');
  assert.deepEqual(result.secretInputs, ['gateway.bootstrap.password', 'gateway.internalSecret']);
  assert.deepEqual(JSON.parse(result.values['gateway.marketplaceRegistryRoute']), { serviceId: 'marketplace-registry', prefix: '/api/v1/marketplace-registry', rewritePrefix: '' });
  assert.deepEqual(JSON.parse(result.values['platform.adapterOptions']).serviceTransport.services, { marketplace: { url: 'http://127.0.0.1:5070' }, 'marketplace-registry': { url: 'http://marketplace-registry:5071' } });
  assert.equal(result.values.existing, 'value');
  assert.equal(input.data.plan.request.marketplaceSources, undefined);
});

test('rejects an invalid plan before writing a request', () => {
  assert.throws(() => registryInstallRequest({ ok: false }, 'http://marketplace-registry:5071'));
  assert.throws(() => registryInstallRequest({ ok: true, data: { plan: { host: { healthUrl: 'http://localhost:4000/health' }, request: {}, configPatches: [] } } }, 'http://marketplace-registry:5071'), /adapterOptions/);
});
