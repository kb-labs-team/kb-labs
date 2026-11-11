/**
 * @module @kb-labs/host-app/plugins-routes
 *
 * Host-owned `/api/v1/plugins` API (stage 6, second slice): per-project
 * list/enable/disable, over HTTP, so Studio can manage a project's plugins
 * without a terminal. It calls the exact same marketplace operations as `kb
 * marketplace plugins list|enable|disable` (`cli/commands/src/commands/system/marketplace/src/
 * commands/plugins/*`) through {@link MarketplaceClient} — the host's internal
 * loopback address for the co-located marketplace module (ADR-0043), so there
 * is never a second `.kb/marketplace.lock` writer. Mounted on the gateway as
 * {@link HostRoutes} (`@kb-labs/gateway-app`), after the gateway's global auth
 * hooks — this module adds no authentication of its own.
 *
 * Response shape mirrors the REST API's envelope (`{ ok: true, data }` /
 * `{ ok: false, error }`) so Studio's existing HTTP client and error mapper
 * handle it unchanged; `error` is the unified envelope (ADR-0049).
 *
 * The action lives in the request body rather than the URL path (`POST
 * /plugins/enable` not `POST /plugins/:id/enable`), matching the marketplace's
 * own `/packages/enable` convention: plugin ids carry `@` and `/`, which
 * round-trip badly as URL-encoded path segments.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createErrorEnvelope, toErrorEnvelope, type ErrorEnvelope } from "@kb-labs/core-platform";
import { projectErrorEnvelope, showProject } from "@kb-labs/core-project-registry";
import type { IProjectRegistry } from "@kb-labs/core-project-registry";
import type { HostRoutes } from "@kb-labs/gateway-app";
import { invalidBody, sendData, sendEnvelope } from "./envelope.js";
import { MarketplaceClientError, type MarketplaceClient } from "./marketplace-client.js";

export interface PluginsRoutesOptions {
  registry: IProjectRegistry;
  marketplace: MarketplaceClient;
}

interface EnableDisableBody {
  projectId?: unknown;
  packageId?: unknown;
}

interface InstallBody {
  projectId?: unknown;
  spec?: unknown;
}

/** Resolves a registered project id to its absolute path. */
async function resolveProjectRoot(registry: IProjectRegistry, projectId: string): Promise<string> {
  const summary = await showProject(registry, projectId);
  return summary.path;
}

/** Marketplace enable/disable throws a plain `Error` for an unknown package id (500). */
function marketplaceErrorEnvelope(error: MarketplaceClientError, plugin: string): ErrorEnvelope {
  if (error.status === 404) {
    return createErrorEnvelope("KB_PLUGIN_NOT_FOUND", {
      details: { plugin },
      cause: error.body || error.message,
    });
  }
  return toErrorEnvelope(error);
}

function requireString(
  reply: FastifyReply,
  value: unknown,
  field: string,
): value is string {
  if (typeof value !== "string" || value.trim() === "") {
    sendEnvelope(reply, invalidBody(field, "must be a non-empty string"));
    return false;
  }
  return true;
}

/**
 * Builds the `/api/v1/plugins` Fastify plugin. The gateway mounts it as
 * {@link HostRoutes} via `GatewayEmbedOptions.hostRoutes`.
 */
export function createPluginsRoutes(options: PluginsRoutesOptions): HostRoutes {
  const { registry, marketplace } = options;

  async function setEnabled(
    request: FastifyRequest<{ Body: EnableDisableBody }>,
    reply: FastifyReply,
    enabled: boolean,
  ) {
    const { projectId, packageId } = request.body ?? {};
    if (!requireString(reply, projectId, "projectId") || !requireString(reply, packageId, "packageId")) {
      return reply;
    }
    try {
      const projectRoot = await resolveProjectRoot(registry, projectId);
      await marketplace.setEnabled({ packageId, scope: "project", projectRoot }, enabled);
      return sendData(reply, { id: packageId, enabled, scope: "project" });
    } catch (error) {
      if (error instanceof MarketplaceClientError) {
        return sendEnvelope(reply, marketplaceErrorEnvelope(error, packageId));
      }
      return sendEnvelope(reply, projectErrorEnvelope(error));
    }
  }

  return async function pluginsRoutes(app: FastifyInstance) {
    app.get<{ Querystring: { projectId?: string } }>(
      "/api/v1/plugins",
      async (request, reply) => {
        const { projectId } = request.query;
        if (!requireString(reply, projectId, "projectId")) {
          return reply;
        }
        try {
          const projectRoot = await resolveProjectRoot(registry, projectId);
          const data = await marketplace.listPackages({ kind: "plugin", scope: "project", projectRoot });
          return sendData(reply, data.entries);
        } catch (error) {
          if (error instanceof MarketplaceClientError) {
            return sendEnvelope(reply, toErrorEnvelope(error));
          }
          return sendEnvelope(reply, projectErrorEnvelope(error));
        }
      },
    );

    app.post<{ Body: EnableDisableBody }>(
      "/api/v1/plugins/enable",
      (request, reply) => setEnabled(request, reply, true),
    );

    app.post<{ Body: EnableDisableBody }>(
      "/api/v1/plugins/disable",
      (request, reply) => setEnabled(request, reply, false),
    );

    app.post<{ Body: InstallBody }>("/api/v1/plugins/install", async (request, reply) => {
      const { projectId, spec } = request.body ?? {};
      if (!requireString(reply, projectId, "projectId") || !requireString(reply, spec, "spec")) {
        return reply;
      }
      try {
        const projectRoot = await resolveProjectRoot(registry, projectId);
        const result = await marketplace.installPackages({ specs: [spec], scope: "project", projectRoot });
        return sendData(reply, result, 201);
      } catch (error) {
        if (error instanceof MarketplaceClientError) {
          return sendEnvelope(reply, marketplaceErrorEnvelope(error, spec));
        }
        return sendEnvelope(reply, projectErrorEnvelope(error));
      }
    });

    app.post<{ Body: EnableDisableBody }>("/api/v1/plugins/uninstall", async (request, reply) => {
      const { projectId, packageId } = request.body ?? {};
      if (!requireString(reply, projectId, "projectId") || !requireString(reply, packageId, "packageId")) {
        return reply;
      }
      try {
        const projectRoot = await resolveProjectRoot(registry, projectId);
        await marketplace.uninstallPackages({ packageIds: [packageId], scope: "project", projectRoot });
        return sendData(reply, { id: packageId, removed: true });
      } catch (error) {
        if (error instanceof MarketplaceClientError) {
          return sendEnvelope(reply, marketplaceErrorEnvelope(error, packageId));
        }
        return sendEnvelope(reply, projectErrorEnvelope(error));
      }
    });
  };
}
