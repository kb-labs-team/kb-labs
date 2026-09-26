/**
 * @module @kb-labs/host-app/project-runtime/routing
 *
 * The host's implementation of the gateway's {@link ProjectRouting} hook:
 * project id -> registry check -> runtime lease -> upstream address and the
 * headers that prove to the runtime that the request comes from the host.
 */

import type { IProjectRegistry } from "@kb-labs/core-contracts";
import { createErrorEnvelope, type IContextLogger } from "@kb-labs/core-platform";
import { isProjectRegistryError } from "@kb-labs/core-project-registry";
import {
  ProjectRoutingError,
  type ProjectRouting,
  type ProjectRoutingStatus,
  type ProjectUpstream,
} from "@kb-labs/gateway-app";
import {
  RUNTIME_PROJECT_HEADER,
  RUNTIME_TOKEN_HEADER,
} from "@kb-labs/project-runtime-app/protocol";
import { ProjectRuntimeError } from "./errors.js";
import type { ProjectRuntimeManager } from "./manager.js";

export interface ProjectRoutingOptions {
  registry: Pick<IProjectRegistry, "list">;
  manager: ProjectRuntimeManager;
  logger: IContextLogger;
}

function unknownProject(projectId: string, cause: string): ProjectRoutingError {
  return new ProjectRoutingError(
    createErrorEnvelope("KB_PROJECT_UNKNOWN", {
      details: { path: projectId },
      cause,
    }),
  );
}

export function createProjectRouting(
  options: ProjectRoutingOptions,
): ProjectRouting {
  const { registry, manager, logger } = options;

  return {
    async acquire(projectId: string): Promise<ProjectUpstream> {
      // Exact id only: the registry's own lookup also accepts names and paths,
      // which must not be addressable through a URL.
      let views;
      try {
        views = await registry.list();
      } catch (error) {
        if (isProjectRegistryError(error)) {
          logger.error("Project registry unavailable", error, {
            code: error.code,
          });
        }
        throw error;
      }
      const view = views.find((candidate) => candidate.project.id === projectId);
      if (!view) {
        throw unknownProject(projectId, "no such project id in the registry");
      }
      if (view.project.status !== "active") {
        throw unknownProject(projectId, `the project is ${view.project.status}`);
      }
      if (!view.pathExists) {
        throw unknownProject(
          projectId,
          "the registered folder does not exist (moved or deleted)",
        );
      }

      try {
        const lease = await manager.acquire({
          id: view.project.id,
          root: view.project.path,
        });
        return {
          host: lease.address.host,
          port: lease.address.port,
          headers: {
            [RUNTIME_TOKEN_HEADER]: lease.token,
            [RUNTIME_PROJECT_HEADER]: lease.projectId,
          },
          release: lease.release,
        };
      } catch (error) {
        if (error instanceof ProjectRuntimeError) {
          throw new ProjectRoutingError(error.envelope);
        }
        throw error;
      }
    },

    status(): ProjectRoutingStatus {
      const snapshot = manager.status();
      return {
        limit: snapshot.limit,
        active: snapshot.active,
        // Public endpoints show state only: no pids, ports, paths or causes.
        runtimes: snapshot.runtimes.map((runtime) => ({
          projectId: runtime.projectId,
          state: runtime.state,
          lastUsedAt: runtime.lastUsedAt,
          inflight: runtime.inflight,
          restarts: runtime.restarts,
        })),
      };
    },
  };
}
