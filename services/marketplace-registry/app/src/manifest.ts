import type { ServiceManifest } from '@kb-labs/plugin-contracts';

export const manifest: ServiceManifest = {
  schema: 'kb.service/1',
  id: 'marketplace-registry',
  name: 'Marketplace Registry',
  version: '1.0.0',
  description: 'Registry for kb:handle/name packages — publish, install, share',
  runtime: {
    entry: 'dist/bootstrap.js',
    port: 5071,
    healthCheck: '/health',
    socket: '/tmp/kb-${KB_SOCKET_HASH}/marketplace-registry.sock',
  },
  dependsOn: ['state-daemon'],
  env: {
    KB_REGISTRY_PORT: { description: 'HTTP port', default: '5071' },
    KB_REGISTRY_HOST: { description: 'Bind host', default: '127.0.0.1' },
  },
};
