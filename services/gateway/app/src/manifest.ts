import type { ServiceManifest } from '@kb-labs/plugin-contracts';

export const manifest: ServiceManifest = {
  schema: 'kb.service/1',
  id: 'gateway',
  name: 'Gateway',
  version: '1.0.0',
  description: 'Central router — aggregates REST API, Workflow, Marketplace',
  runtime: {
    entry: 'dist/bin.js',
    port: 4000,
    healthCheck: '/health',
  },
  dependsOn: ['rest', 'workflow'],
  env: {
    PORT: { description: 'HTTP port', default: '4000' },
    NODE_ENV: { description: 'Environment mode', default: 'development' },
  },
};

export default manifest;
