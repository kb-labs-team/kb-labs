/**
 * @module @kb-labs/gateway-app/host-routes
 *
 * Extension point for machine-level API routes owned by the embedding host
 * (for example `/api/v1/projects`). The gateway only mounts the plugin, after
 * its global auth hooks and before it starts listening; it does not know what
 * the routes do. Routes must not collide with the gateway's own paths or with
 * `/api/v1/projects/{projectId}/*`, which is reserved for project runtimes.
 */

import type { FastifyPluginAsync } from "fastify";

/** A Fastify plugin registered by the gateway on behalf of the host. */
export type HostRoutes = FastifyPluginAsync;
