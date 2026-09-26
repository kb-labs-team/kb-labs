/**
 * @module @kb-labs/project-runtime-app/protocol
 *
 * The wire contract between the host (which supervises project runtimes) and a
 * project runtime process. Kept in one place so both sides import the same
 * names.
 */

/** Request header carrying the shared secret. Only the host knows it. */
export const RUNTIME_TOKEN_HEADER = "x-kb-runtime-token";

/** Request header set by the host so a module can tell which project it serves. */
export const RUNTIME_PROJECT_HEADER = "x-kb-project-id";

/** Environment variable that carries the shared secret into the runtime (never argv). */
export const RUNTIME_TOKEN_ENV = "KB_PROJECT_RUNTIME_TOKEN";

/** Runtime-level liveness/identity endpoint, answered by the runtime itself. */
export const RUNTIME_HEALTH_PATH = "/__runtime/health";

/** Body of `GET /__runtime/health`. */
export interface RuntimeHealth {
  status: "ok" | "degraded";
  projectId: string;
  projectRoot: string;
  pid: number;
  uptimeSec: number;
  /** Per-module TCP reachability. */
  modules: Record<string, "up" | "down">;
}

/** Command-line contract of the `kb-project-runtime` executable. */
export const RUNTIME_ARGS = {
  projectRoot: "--project-root",
  projectId: "--project-id",
  listen: "--listen",
  parentPid: "--parent-pid",
} as const;
