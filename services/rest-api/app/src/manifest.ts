import type { ServiceManifest } from '@kb-labs/plugin-contracts';

export const manifest: ServiceManifest = {
  schema: 'kb.service/1',
  id: 'rest',
  name: 'REST API',
  version: '1.2.0',
  description: 'Platform REST API daemon — routes, plugin execution, OpenAPI',
  runtime: {
    entry: 'dist/bin.js',
    port: 5050,
    // REST health aggregates registry and adapter state and can remain
    // unavailable while the process is already serving its socket. kb-dev's
    // startup gate needs the process-readiness probe; runtime health remains
    // available at /api/v1/health for observability.
    healthCheck: 'localhost:5050',
    // No socket: the gateway proxies WebSocket traffic to rest (upstream
    // websocket: true on /api/v1). @fastify/http-proxy's WS upgrade uses the
    // `ws` client, which cannot dial a unix socket (undici.socketPath applies
    // only to HTTP), so rest must stay on TCP for WS proxying to work.
  },
  env: {
    PORT: { description: 'HTTP port', default: '5050' },
    REST_API_HOST: { description: 'Bind host', default: '127.0.0.1' },
    NODE_ENV: { description: 'Environment mode', default: 'development' },
  },
};

export default manifest;
