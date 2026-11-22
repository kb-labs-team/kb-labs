/**
 * @module @kb-labs/marketplace-api/routes
 * Register all marketplace API routes.
 */

import type { FastifyInstance } from 'fastify';
import { registerPackagesRoutes } from './packages.js';
import { registerWorkspaceRoutes } from './workspace.js';
import { registerDiagnosticsRoutes } from './diagnostics.js';
import type { MarketplaceMutationAuth } from './mutation-auth.js';

export async function registerRoutes(server: FastifyInstance, mutationAuth: MarketplaceMutationAuth): Promise<void> {
  await server.register(async (app) => {
    registerPackagesRoutes(app, mutationAuth);
    registerWorkspaceRoutes(app, mutationAuth);
    registerDiagnosticsRoutes(app);
  }, { prefix: '/api/v1/marketplace' });
}
