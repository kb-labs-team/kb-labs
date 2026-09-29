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

import type { FastifyInstance } from "fastify";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createErrorEnvelope } from "@kb-labs/core-platform";
import type {
  IProjectRegistry,
  ProjectDirectoryListing,
  ProjectEntry,
  ProjectRuntimeInfo,
  ProjectRuntimeState,
  ProjectSummary,
} from "@kb-labs/core-contracts";
import {
  addProject,
  canonicalizeProjectPath,
  createProject,
  isProjectRegistryError,
  listProjects,
  projectErrorEnvelope,
  ProjectRegistryError,
  showProject,
} from "@kb-labs/core-project-registry";
import type { HostRoutes } from "@kb-labs/gateway-app";
import { invalidBody, sendData, sendEnvelope } from "./envelope.js";
import type { ProjectRuntimeManager } from "./project-runtime/manager.js";

export interface ProjectsRoutesOptions {
  registry: IProjectRegistry;
  manager: ProjectRuntimeManager;
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

/**
 * This endpoint is intentionally limited to the project-folder picker. It
 * returns child directory names and paths only: no files, contents or
 * metadata. The Gateway's existing authentication protects access to it.
 */
async function listProjectDirectories(path?: string): Promise<ProjectDirectoryListing> {
  if (path === undefined) {
    const candidates = [process.cwd(), homedir()];
    const directories = await Promise.all(candidates.map(async (candidate) => {
      try {
        const canonicalPath = await canonicalizeProjectPath(candidate);
        return { name: canonicalPath, path: canonicalPath };
      } catch {
        return null;
      }
    }));
    const unique = new Map(directories.filter((entry) => entry !== null).map((entry) => [entry.path, entry]));
    return { currentPath: null, parentPath: null, directories: [...unique.values()] };
  }

  const currentPath = await canonicalizeProjectPath(path);
  let entries;
  try {
    entries = await fs.readdir(currentPath, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") {
      throw new ProjectRegistryError("KB_PROJECT_NO_ACCESS", `No permission to read: ${currentPath}`, { path: currentPath });
    }
    throw error;
  }

  const parent = dirname(currentPath);
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, path: join(currentPath, entry.name) }))
    .sort((left, right) => left.name.localeCompare(right.name));

  return { currentPath, parentPath: parent === currentPath ? null : parent, directories };
}

interface AddProjectBody {
  path?: unknown;
  name?: unknown;
  title?: unknown;
  description?: unknown;
  init?: unknown;
}

interface UpdateProjectBody {
  path?: unknown;
  title?: unknown;
  description?: unknown;
}

interface CreateProjectBody {
  parentPath?: unknown;
  directoryName?: unknown;
  title?: unknown;
  description?: unknown;
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
    app.get<{ Querystring: { path?: string } }>("/api/v1/projects/directories", async (request, reply) => {
      try {
        const listing = await listProjectDirectories(request.query.path);
        return sendData(reply, listing);
      } catch (error) {
        return sendEnvelope(reply, projectErrorEnvelope(error));
      }
    });

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
        const { path, name, title, description, init } = request.body ?? {};
        if (typeof path !== "string" || path.trim() === "") {
          return sendEnvelope(reply, invalidBody("path", "must be a non-empty string"));
        }
        if (name !== undefined && typeof name !== "string") {
          return sendEnvelope(reply, invalidBody("name", "must be a string"));
        }
        if (title !== undefined && typeof title !== "string") {
          return sendEnvelope(reply, invalidBody("title", "must be a string"));
        }
        if (description !== undefined && typeof description !== "string") {
          return sendEnvelope(reply, invalidBody("description", "must be a string"));
        }
        if (init !== undefined && typeof init !== "boolean") {
          return sendEnvelope(reply, invalidBody("init", "must be a boolean"));
        }

        try {
          const outcome = await addProject(registry, {
            path,
            name,
            title: title as string | undefined,
            description: description as string | undefined,
            init: init === true,
          });
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

    app.post<{ Body: CreateProjectBody }>(
      "/api/v1/projects/create",
      async (request, reply) => {
        const { parentPath, directoryName, title, description } = request.body ?? {};
        if (typeof parentPath !== "string" || parentPath.trim() === "") {
          return sendEnvelope(reply, invalidBody("parentPath", "must be a non-empty string"));
        }
        if (typeof directoryName !== "string" || directoryName.trim() === "") {
          return sendEnvelope(reply, invalidBody("directoryName", "must be a non-empty string"));
        }
        if (typeof title !== "string" || title.trim() === "") {
          return sendEnvelope(reply, invalidBody("title", "must be a non-empty string"));
        }
        if (description !== undefined && typeof description !== "string") {
          return sendEnvelope(reply, invalidBody("description", "must be a string"));
        }
        try {
          const project = await createProject(registry, {
            parentPath,
            directoryName,
            title,
            description: description as string | undefined,
          });
          const summary = await showProject(registry, project.id);
          return sendData(reply, toEntry(manager, summary), 201);
        } catch (error) {
          return sendEnvelope(reply, projectErrorEnvelope(error));
        }
      },
    );

    app.patch<{ Params: { id: string }; Body: UpdateProjectBody }>(
      "/api/v1/projects/:id",
      async (request, reply) => {
        const { path, title, description } = request.body ?? {};
        if (path !== undefined && typeof path !== "string") {
          return sendEnvelope(reply, invalidBody("path", "must be a string"));
        }
        if (typeof path === "string" && path.trim() === "") {
          return sendEnvelope(reply, invalidBody("path", "must not be empty"));
        }
        if (title !== undefined && typeof title !== "string") {
          return sendEnvelope(reply, invalidBody("title", "must be a string"));
        }
        if (description !== undefined && typeof description !== "string") {
          return sendEnvelope(reply, invalidBody("description", "must be a string"));
        }
        try {
          await registry.update(request.params.id, {
            ...(path !== undefined ? { path: path as string } : {}),
            ...(title !== undefined ? { title: title as string } : {}),
            ...(description !== undefined ? { description: description as string } : {}),
          });
          const summary = await showProject(registry, request.params.id);
          return sendData(reply, toEntry(manager, summary));
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
