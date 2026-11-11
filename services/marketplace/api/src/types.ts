/**
 * Fastify module augmentation — typed marketplace service on app instance.
 */

import type { MarketplaceService } from '@kb-labs/marketplace-core';
import type { HttpObservabilityCollector } from '@kb-labs/shared-http';

declare module 'fastify' {
  interface FastifyInstance {
    marketplace: MarketplaceService;
    observability: HttpObservabilityCollector;
  }
}
