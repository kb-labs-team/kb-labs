/**
 * @module @kb-labs/sdk/errors
 * Platform-owned error envelope and catalogue contracts for plugin authors.
 */

export type {
  ErrorEnvelope,
  CatalogErrorRequest,
  ErrorAction,
  ErrorCatalogEntry,
  PlatformErrorCode,
  DetailsOptionFor,
} from '@kb-labs/core-platform/error-envelope';

export {
  errorCatalog,
  getCatalogEntry,
  isErrorCode,
  createErrorEnvelope,
  createCatalogErrorEnvelope,
} from '@kb-labs/core-platform/error-envelope';
