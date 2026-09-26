import type { ProjectRegistryErrorCode } from '@kb-labs/core-contracts';

/**
 * Typed registry failure. `code` is a stable catalog code; `details` holds the
 * secret-free values that fill the catalog message/hint templates.
 * Command layers convert it to an error envelope with `createErrorEnvelope`.
 */
export class ProjectRegistryError extends Error {
  readonly code: ProjectRegistryErrorCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(code: ProjectRegistryErrorCode, message: string, details: Record<string, string> = {}) {
    super(message);
    this.name = 'ProjectRegistryError';
    this.code = code;
    this.details = details;
  }
}

export function isProjectRegistryError(value: unknown): value is ProjectRegistryError {
  return value instanceof ProjectRegistryError;
}
