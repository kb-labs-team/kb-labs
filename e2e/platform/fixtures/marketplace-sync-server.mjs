import { createContextLogger } from '@kb-labs/core-platform';
import { createServer } from '@kb-labs/marketplace-api';
import { MarketplaceService } from '@kb-labs/marketplace-core';

const root = process.argv[2];
const requestRecorder = process.argv[3] === '--request-recorder';
if (!root) {
  throw new Error('Marketplace sync fixture requires the workspace root');
}

const baseLogger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  async flush() {},
  child() { return baseLogger; },
};
const logger = createContextLogger(baseLogger, {
  applicationId: 'marketplace-sync-fixture',
  serviceId: 'marketplace',
  instanceId: String(process.pid),
  layer: 'service',
});
const service = new MarketplaceService({
  platformRoot: root,
  projectRoot: root,
  sources: [],
  logger,
});
const server = await createServer({ service, logger });
let marketplaceRequestCount = 0;
server.addHook('onRequest', async (request, reply) => {
  if (request.url.startsWith('/api/v1/marketplace/')) {
    marketplaceRequestCount++;
    if (requestRecorder) {
      return reply.code(204).send();
    }
  }
});
server.get('/__journey/request-count', async () => ({ count: marketplaceRequestCount }));
await server.listen({ host: '127.0.0.1', port: 0 });
const address = server.server.address();
if (address === null || typeof address === 'string') {
  throw new Error('Marketplace sync fixture did not bind a TCP port');
}
process.stdout.write(`${JSON.stringify({ url: `http://127.0.0.1:${address.port}` })}\n`);

process.once('SIGTERM', () => {
  void server.close().then(() => process.exit(0));
});
