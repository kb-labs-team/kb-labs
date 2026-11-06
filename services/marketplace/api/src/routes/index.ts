/**
 * @module @kb-labs/marketplace-api/routes
 * Register all marketplace API routes.
 */

import type { FastifyInstance } from 'fastify';
import { registerPackagesRoutes } from './packages.js';
import { registerWorkspaceRoutes } from './workspace.js';
import { registerDiagnosticsRoutes } from './diagnostics.js';

export async function registerRoutes(server: FastifyInstance): Promise<void> {
  await server.register(async (app) => {
    registerPackagesRoutes(app);
    registerWorkspaceRoutes(app);
    registerDiagnosticsRoutes(app);
  }, { prefix: '/api/v1/marketplace' });
}
