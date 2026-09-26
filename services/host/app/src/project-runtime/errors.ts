import { createErrorEnvelope, type ErrorEnvelope } from "@kb-labs/core-platform";

/**
 * A project-runtime failure that maps to a catalog error code
 * (`KB_PROJECT_RUNTIME_START_FAILED`, `KB_PROJECT_RUNTIME_LIMIT`). Carries the
 * unified error envelope so the gateway can answer with it.
 */
export class ProjectRuntimeError extends Error {
  readonly envelope: ErrorEnvelope;

  constructor(envelope: ErrorEnvelope) {
    super(
      `${envelope.code}: ${envelope.message}${envelope.cause ? ` (${envelope.cause})` : ""}`,
    );
    this.name = "ProjectRuntimeError";
    this.envelope = envelope;
  }
}

/** The runtime of `projectId` did not start (or could not be kept running). */
export function runtimeStartFailed(
  projectId: string,
  cause: string,
): ProjectRuntimeError {
  return new ProjectRuntimeError(
    createErrorEnvelope("KB_PROJECT_RUNTIME_START_FAILED", {
      details: { project: projectId },
      cause,
    }),
  );
}

/** Every allowed runtime slot is in use by a project with requests in flight. */
export function runtimeLimitReached(limit: number): ProjectRuntimeError {
  return new ProjectRuntimeError(
    createErrorEnvelope("KB_PROJECT_RUNTIME_LIMIT", {
      details: { limit: String(limit) },
      cause: `all ${limit} active project runtimes are handling requests`,
    }),
  );
}
