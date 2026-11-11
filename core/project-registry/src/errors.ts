import type { ProjectRegistryErrorCode } from '@kb-labs/core-contracts';
import type { DetailsFor, PlatformErrorCode, CatalogErrorRequest } from '@kb-labs/core-platform';

/**
 * Typed registry failure. `code` is a stable catalog code; `details` holds the
 * secret-free values that fill the catalog message/hint templates.
 * Command layers convert it to an error envelope with `createErrorEnvelope`.
 */
export type ProjectRegistryErrorRequest = Extract<CatalogErrorRequest, { code: ProjectRegistryErrorCode }> & { details: DetailsFor<ProjectRegistryErrorCode & PlatformErrorCode> };

export class ProjectRegistryError extends Error {
  readonly request: ProjectRegistryErrorRequest;
  readonly code: ProjectRegistryErrorCode;
  readonly details: DetailsFor<ProjectRegistryErrorCode & PlatformErrorCode>;

  constructor(request: ProjectRegistryErrorRequest, message: string) {
    super(message);
    this.name = 'ProjectRegistryError';
    this.request = request;
    this.code = request.code;
    this.details = request.details;
  }
}

export function isProjectRegistryError(value: unknown): value is ProjectRegistryError {
  return value instanceof ProjectRegistryError;
}
