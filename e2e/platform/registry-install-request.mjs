import { readFileSync, writeFileSync } from 'node:fs';

export function registryInstallRequest(envelope, upstream) {
  if (envelope?.ok !== true || !envelope.data?.plan?.request) throw new Error('invalid install plan envelope');
  const plan = envelope.data.plan;
  const health = new URL(plan.host.healthUrl);
  if (!health.pathname.endsWith('/health')) throw new Error('invalid Gateway health URL');
  health.pathname = health.pathname.slice(0, -'/health'.length).replace(/\/$/, '');
  health.search = '';
  health.hash = '';
  const gateway = health.toString().replace(/\/$/, '');
  const request = structuredClone(plan.request);
  request.marketplaceSources ??= {};
  request.marketplaceSources.registryUrl = `${gateway}/api/v1/marketplace-registry`;
  request.marketplaceSources.signingPublicKeyEnv = 'KB_E2E_REGISTRY_PUBLIC_KEY';
  request.gatewayUrl = gateway;
  request.secretInputs ??= [];
  if (!request.secretInputs.includes('gateway.internalSecret')) request.secretInputs.push('gateway.internalSecret');
  request.values ??= {};
  request.values['gateway.marketplaceRegistryRoute'] = JSON.stringify({ serviceId: 'marketplace-registry', prefix: '/api/v1/marketplace-registry', rewritePrefix: '' });
  const patch = plan.configPatches?.find((item) => item.path === '/platform/adapterOptions');
  if (typeof patch?.json !== 'string') throw new Error('install plan omitted platform.adapterOptions');
  const options = JSON.parse(patch.json);
  options.serviceTransport ??= {};
  options.serviceTransport.services ??= {};
  options.serviceTransport.services['marketplace-registry'] = { url: upstream };
  request.values['platform.adapterOptions'] = JSON.stringify(options);
  return request;
}

if (process.argv[1]?.endsWith('/registry-install-request.mjs')) {
  const [, , input, output, upstream] = process.argv;
  if (!input || !output || !upstream) throw new Error('usage: registry-install-request.mjs PLAN OUTPUT UPSTREAM');
  writeFileSync(output, `${JSON.stringify(registryInstallRequest(JSON.parse(readFileSync(input, 'utf8')), upstream))}\n`, { mode: 0o600 });
}
