import {
  createCatalogErrorEnvelope,
  getCatalogEntry,
  type CatalogErrorRequest,
  type ErrorCatalogEntry,
  type ErrorEnvelope,
  type PlatformErrorCode,
} from '@kb-labs/sdk/errors';

export type ReleaseErrorCode = Extract<PlatformErrorCode, `KB_RELEASE_${string}`>;

export function describeReleaseError(code: ReleaseErrorCode): ErrorCatalogEntry {
  const entry = getCatalogEntry(code);
  if (!entry) {
    throw new Error(`Release error code ${code} is missing from the platform error catalog.`);
  }
  return entry;
}

export type CreateReleaseErrorInput = Extract<CatalogErrorRequest, { code: ReleaseErrorCode }>;

/** Build a release failure from the shared platform catalog. */
export function createReleaseError(input: CreateReleaseErrorInput): ErrorEnvelope {
  describeReleaseError(input.code);
  return createCatalogErrorEnvelope(input);
}
