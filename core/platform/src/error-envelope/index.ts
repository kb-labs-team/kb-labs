/**
 * @module @kb-labs/core-platform/error-envelope
 * Unified error envelope, catalog and adapters. See 08-errors.md.
 */

export * from './types.js';
export type { ValidatedErrorEnvelope } from './validated-envelope.js';
export * from './execution-request.js';
export * from './execution-response.js';
export * from './execution-transport.js';
export * from './host-resolver.js';
export * from './subprocess-runner.js';
export * from './validate.js';
export * from './catalog.js';
export { catalogEnvironmentVariables } from './error-codes.generated.js';
export * from './from-error.js';
