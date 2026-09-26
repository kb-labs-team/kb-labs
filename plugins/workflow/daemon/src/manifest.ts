import type { ServiceManifest } from '@kb-labs/plugin-contracts';

export const manifest: ServiceManifest = {
  schema: 'kb.service/1',
  id: 'workflow',
  name: 'Workflow Engine',
  version: '1.2.0',
  description: 'Workflow orchestration daemon — runs, schedules, cron',
  runtime: {
    entry: 'dist/bin.js',
    port: 7778,
    healthCheck: '/health',
    socket: '/tmp/kb-${KB_SOCKET_HASH}/workflow.sock',
  },
  env: {
    PORT: { description: 'HTTP port', default: '7778' },
    WORKFLOW_HOST: { description: 'Bind host', default: '127.0.0.1' },
    NODE_ENV: { description: 'Environment mode', default: 'development' },
  },
};

export default manifest;
