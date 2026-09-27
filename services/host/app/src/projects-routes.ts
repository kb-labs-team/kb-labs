/**
 * @module @kb-labs/host-app/projects-routes
 *
 * Host-owned `/api/v1/projects` API (stage 6, first slice): the same
 * add/list/show/remove operations as `kb project *`, over HTTP, so Studio can
 * drive the registry without a terminal. Mounted on the gateway as
 * {@link HostRoutes} (`@kb-labs/gateway-app`), after the gateway's global auth
 * hooks — this module adds no authentication of its own.
 *
 * Trust note: any request the gateway already authenticates (a machine Bearer
 * token, or — when `host.auth` is on — a user session) may add any filesystem
 * path readable by the host process to the registry. That is the same trust
 * boundary `kb project add` has always had (a local shell can register any
 * path); this endpoint does not add a path allow-list on top of it, and it
 * must not be treated as safe to expose beyond the existing host.auth model.
 *
 * Response shape mirrors the REST API's envelope (`{ ok: true, data }` /
 * `{ ok: false, error }`) so Studio's existing HTTP client and error mapper
 * handle it unchanged; `error` is the unified envelope (ADR-0049).
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import { createErrorEnvelope, type ErrorEnvelope } from "@kb-labs/core-platform";
import type {
  IProjectRegistry,
  ProjectEntry,
  ProjectRuntimeInfo,
  ProjectRuntimeState,
  ProjectSummary,
} from "@kb-labs/core-contracts";
import {
  addProject,
  isProjectRegistryError,
  listProjects,
  projectErrorEnvelope,
  showProject,
} from "@kb-labs/core-project-registry";
import type { HostRoutes } from "@kb-labs/gateway-app";
import type { ProjectRuntimeManager } from "./project-runtime/manager.js";

export interface ProjectsRoutesOptions {
  registry: IProjectRegistry;
  manager: ProjectRuntimeManager;
}

const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  KB_PROJECT_PATH_NOT_FOUND: 404,
  KB_PROJECT_NOT_A_DIRECTORY: 400,
  KB_PROJECT_NO_ACCESS: 403,
  KB_PROJECT_ALREADY_REGISTERED: 409,
  KB_PROJECT_UNKNOWN: 404,
  KB_PROJECT_NAME_TAKEN: 409,
  KB_PROJECT_DECLARATION_INVALID: 422,
  KB_PROJECT_REGISTRY_CORRUPT: 500,
  KB_PROJECT_REGISTRY_SCHEMA_UNSUPPORTED: 500,
  KB_PROJECT_REGISTRY_LOCKED: 503,
  KB_PROJECT_INIT_REQUIRED: 409,
  KB_RUNTIME_INPUT_INVALID: 400,
};

function statusFor(envelope: ErrorEnvelope): number {
  return STATUS_BY_CODE[envelope.code] ?? 500;
}

function sendEnvelope(reply: FastifyReply, envelope: ErrorEnvelope): FastifyReply {
  return reply.code(statusFor(envelope)).send({ ok: false, error: envelope });
}

function sendData(reply: FastifyReply, data: unknown, status = 200): FastifyReply {
  return reply.code(status).send({ ok: true, data });
}

/** `stopped` for a registered project the manager has no entry for. */
function runtimeInfoFor(
  manager: ProjectRuntimeManager,
  projectId: string,
): ProjectRuntimeInfo {
  const runtime = manager
    .status()
    .runtimes.find((candidate) => candidate.projectId === projectId);
  if (!runtime) {
    return { state: "stopped", restarts: 0 };
  }
  return {
    state: runtime.state as ProjectRuntimeState,
    lastUsedAt: runtime.lastUsedAt,
    restarts: runtime.restarts,
  };
}

function toEntry(
  manager: ProjectRuntimeManager,
  summary: ProjectSummary,
): ProjectEntry {
  return { ...summary, runtime: runtimeInfoFor(manager, summary.id) };
}

interface AddProjectBody {
  path?: unknown;
  name?: unknown;
  init?: unknown;
}

function invalidBody(field: string, expected: string): ErrorEnvelope {
  return createErrorEnvelope("KB_RUNTIME_INPUT_INVALID", {
    cause: `"${field}" ${expected}.`,
    details: { field },
  });
}

/**
 * Builds the `/api/v1/projects` Fastify plugin. The gateway mounts it as
 * {@link HostRoutes} via `GatewayEmbedOptions.hostRoutes`.
 */
export function createProjectsRoutes(
  options: ProjectsRoutesOptions,
): HostRoutes {
  const { registry, manager } = options;

  return async function projectsRoutes(app: FastifyInstance) {
    app.get("/api/v1/projects", async (_request, reply) => {
      const summaries = await listProjects(registry);
      return sendData(reply, summaries.map((summary) => toEntry(manager, summary)));
    });

    app.get<{ Params: { id: string } }>(
      "/api/v1/projects/:id",
      async (request, reply) => {
        try {
          const summary = await showProject(registry, request.params.id);
          return sendData(reply, toEntry(manager, summary));
        } catch (error) {
          return sendEnvelope(reply, projectErrorEnvelope(error));
        }
      },
    );

    app.post<{ Body: AddProjectBody }>(
      "/api/v1/projects",
      async (request, reply) => {
        const { path, name, init } = request.body ?? {};
        if (typeof path !== "string" || path.trim() === "") {
          return sendEnvelope(reply, invalidBody("path", "must be a non-empty string"));
        }
        if (name !== undefined && typeof name !== "string") {
          return sendEnvelope(reply, invalidBody("name", "must be a string"));
        }
        if (init !== undefined && typeof init !== "boolean") {
          return sendEnvelope(reply, invalidBody("init", "must be a boolean"));
        }

        try {
          const outcome = await addProject(registry, { path, name, init: init === true });
          if (outcome.status === "initialization-required") {
            return sendEnvelope(
              reply,
              createErrorEnvelope("KB_PROJECT_INIT_REQUIRED", {
                details: { path: outcome.path },
              }),
            );
          }
          // `status === "planned"` cannot happen: this route never passes `dryRun`.
          const summary = await showProject(registry, outcome.project.id);
          return sendData(reply, toEntry(manager, summary), 201);
        } catch (error) {
          return sendEnvelope(reply, projectErrorEnvelope(error));
        }
      },
    );

    app.delete<{ Params: { id: string } }>(
      "/api/v1/projects/:id",
      async (request, reply) => {
        try {
          const removed = await registry.remove(request.params.id);
          return sendData(reply, { id: removed.id });
        } catch (error) {
          if (isProjectRegistryError(error)) {
            return sendEnvelope(reply, projectErrorEnvelope(error));
          }
          throw error;
        }
      },
    );
  };
}
