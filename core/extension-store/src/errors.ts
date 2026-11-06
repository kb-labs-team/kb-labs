import { createCatalogErrorEnvelope, type DetailsFor, type ErrorEnvelope, type PlatformErrorCode, type CatalogErrorRequest } from '@kb-labs/core-platform';

export type ExtensionStoreErrorCode =
  | 'KB_PLUGIN_INTEGRITY_MISMATCH'
  | 'KB_PLUGIN_INSTALL_FAILED'
  | 'KB_RUNTIME_INPUT_INVALID';

/**
 * Typed store failure. `code` is a stable catalog code; `details` holds the
 * secret-free values that fill the catalog message/hint templates. Command
 * layers convert it to an error envelope with `createCatalogErrorEnvelope`.
 */
export class ExtensionStoreError extends Error {
  readonly code: ExtensionStoreErrorCode;
  readonly envelope: ErrorEnvelope;
  readonly details: DetailsFor<ExtensionStoreErrorCode & PlatformErrorCode>;

  constructor(request: Extract<CatalogErrorRequest, { code: ExtensionStoreErrorCode }> & { details: DetailsFor<ExtensionStoreErrorCode & PlatformErrorCode> }) {
    const envelope = createCatalogErrorEnvelope(request);
    super(`${envelope.code}: ${envelope.message} ${envelope.hint}`);
    this.name = 'ExtensionStoreError';
    this.code = request.code;
    this.envelope = envelope;
    this.details = request.details;
  }
}

/**
 * A store entry's recorded integrity does not match what the caller expected
 * (a project's pin, or the value observed right after install). Carries
 * `KB_PLUGIN_INTEGRITY_MISMATCH`.
 */
export class IntegrityMismatchError extends ExtensionStoreError {
  constructor(details: { plugin: string; expected: string; actual: string }) {
    super(
      { code: 'KB_PLUGIN_INTEGRITY_MISMATCH', details, cause: `Store entry for "${details.plugin}" has integrity ${details.actual}, expected ${details.expected}.` },
    );
    this.name = 'IntegrityMismatchError';
  }
}

/**
 * The package manager failed to install a version into the store (network,
 * registry, or a bad spec). Carries `KB_PLUGIN_INSTALL_FAILED`.
 */
export class StoreInstallError extends ExtensionStoreError {
  constructor(details: { plugin: string }, cause: string) {
    super({ code: 'KB_PLUGIN_INSTALL_FAILED', details, cause });
    this.name = 'StoreInstallError';
  }
}

export function isExtensionStoreError(value: unknown): value is ExtensionStoreError {
  return value instanceof ExtensionStoreError;
}
