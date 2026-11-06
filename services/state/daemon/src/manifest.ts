import type { ServiceManifest } from '@kb-labs/plugin-contracts';

export const manifest: ServiceManifest = {
  schema: 'kb.service/1',
  id: 'state-daemon',
  name: 'State Daemon',
  version: '1.4.0',
  description: 'Distributed state management (State Broker HTTP server)',
  runtime: {
    entry: 'dist/bin.cjs',
    healthCheck: '/health',
    // No socket: state-daemon stays on TCP. Its consumers use the host-provided live address
    // directly — not through the gateway/serviceTransport — so a socket-only
    // bind would break them.
  },
  env: {
    KB_STATE_DAEMON_PORT: { description: 'HTTP port for standalone daemon runs' },
    NODE_ENV: { description: 'Environment mode', default: 'development' },
  },
};
