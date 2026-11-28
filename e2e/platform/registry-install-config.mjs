import { readFileSync, writeFileSync } from 'node:fs';

export function registryInstallConfig(envelope, upstream) {
  if (envelope?.ok !== true || !envelope.data?.plan?.request) throw new Error('invalid install plan envelope');
  const plan = envelope.data.plan;
  const health = new URL(plan.host.healthUrl);
  if (!health.pathname.endsWith('/health')) throw new Error('invalid Gateway health URL');
  health.pathname = health.pathname.slice(0, -'/health'.length).replace(/\/$/, '');
  health.search = '';
  health.hash = '';
  const gateway = health.toString().replace(/\/$/, '');
  const config = {
    marketplaceSources: {
      registryUrl: `${gateway}/api/v1/marketplace-registry`,
      npmUrl: 'http://verdaccio:4873',
      signingPublicKeyEnv: 'KB_E2E_REGISTRY_PUBLIC_KEY',
    },
    serviceTransportURLs: { 'marketplace-registry': upstream },
    secretInputs: ['gateway.internalSecret'],
    values: {
      'gateway.marketplaceRegistryRoute': { serviceId: 'marketplace-registry', prefix: '/api/v1/marketplace-registry', rewritePrefix: '' },
    },
  };
  return config;
}

if (process.argv[1]?.endsWith('/registry-install-config.mjs')) {
  const [, , planPath, configPath, upstream] = process.argv;
  if (!planPath || !configPath || !upstream) throw new Error('usage: registry-install-config.mjs PLAN CONFIG UPSTREAM');
  writeFileSync(configPath, `${JSON.stringify(registryInstallConfig(JSON.parse(readFileSync(planPath, 'utf8')), upstream))}\n`, { mode: 0o600 });
}
