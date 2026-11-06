/**
 * Error types for V3 Plugin System
 *
 * Standardized errors with codes for proper handling across IPC boundaries.
 */

import type {
  DetailsArgumentFor,
  DetailsFor,
  PlatformErrorCode,
  ProductErrorCode,
  ErrorCode,
  ValidatedErrorEnvelope,
} from '@kb-labs/core-platform/error-envelope';
import { createProductErrorEnvelope, getCatalogEntry, isErrorCode } from '@kb-labs/core-platform/error-envelope';

type PluginErrorArguments<C extends ErrorCode> = C extends PlatformErrorCode
  ? [code: C, ...DetailsArgumentFor<C>, hint?: string]
  : [code: C, statusCode: number, details?: Record<string, string>, hint?: string];
type PluginErrorDetails<C extends ErrorCode> = C extends PlatformErrorCode ? DetailsFor<C> : Record<string, string>;

/**
 * Base plugin error class
 */
export class PluginError<C extends ErrorCode = PlatformErrorCode> extends Error {
  /**
   * Error code for programmatic handling
   */
  public readonly code: C;
  /** HTTP response status derived from the platform error catalog. */
  public readonly statusCode: number;

  /**
   * Additional error details
   */
  public readonly details?: PluginErrorDetails<C>;
  public readonly hint?: string;

  constructor(message: string, ...args: PluginErrorArguments<C>);
  constructor(message: string, ...args: [C, ...unknown[]]) {
    const [code, ...values] = args;
    if (typeof code !== 'string') throw new TypeError('PluginError requires a validated error code.');
    const platformCode = isErrorCode(code) ? code : undefined;
    const details = platformCode ? values[0] as DetailsFor<PlatformErrorCode> | undefined : values[1] as Record<string, string> | undefined;
    const hint = platformCode ? values[1] as string | undefined : values[2] as string | undefined;
    const statusCode = platformCode ? getCatalogEntry(platformCode).httpStatus : values[0] as number;
    super(message);
    this.name = 'PluginError';
    this.code = code as C;
    this.statusCode = statusCode;
    this.details = details as PluginErrorDetails<C> | undefined;
    this.hint = hint;

    // Ensure prototype chain is correct
    Object.setPrototypeOf(this, new.target.prototype);
  }

}

/** Product failures use their independently validated flat-detail contract. */
export class ProductPluginError extends PluginError<ProductErrorCode> {
  readonly envelope: ValidatedErrorEnvelope & { code: ProductErrorCode };

  constructor(message: string, code: ProductErrorCode, statusCode: number, details: Record<string, string> | undefined, hint: string) {
    const envelope = createProductErrorEnvelope({ code, message, details, hint, retryable: false });
    super(message, envelope.code, statusCode, details, envelope.hint);
    this.name = 'ProductPluginError';
    this.envelope = envelope;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Permission denied error
 */
export class PermissionError extends PluginError<'KB_PLUGIN_PERMISSION_DENIED'> {
  constructor(message: string, details: DetailsFor<'KB_PLUGIN_PERMISSION_DENIED'>) {
    super(message, 'KB_PLUGIN_PERMISSION_DENIED', details);
    this.name = 'PermissionError';
  }
}

/**
 * Operation timeout error
 */
export class TimeoutError extends PluginError<'KB_RUNTIME_TIMEOUT'> {
  constructor(message: string, details?: DetailsFor<'KB_RUNTIME_TIMEOUT'>) {
    super(message, 'KB_RUNTIME_TIMEOUT', details);
    this.name = 'TimeoutError';
  }
}

/**
 * Operation aborted error (e.g., by signal)
 */
export class AbortError extends PluginError<'KB_PLUGIN_ABORTED'> {
  constructor(message: string = 'Operation aborted') {
    super(message, 'KB_PLUGIN_ABORTED');
    this.name = 'AbortError';
  }
}

/**
 * Configuration error
 */
export class ConfigError extends PluginError<'KB_CONFIG_INVALID'> {
  constructor(message: string, details: DetailsFor<'KB_CONFIG_INVALID'>) {
    super(message, 'KB_CONFIG_INVALID', details);
    this.name = 'ConfigError';
  }
}

/**
 * Validation error
 */
export class ValidationError extends PluginError<'KB_RUNTIME_INPUT_INVALID'> {
  constructor(message: string, details?: DetailsFor<'KB_RUNTIME_INPUT_INVALID'>) {
    super(message, 'KB_RUNTIME_INPUT_INVALID', details);
    this.name = 'ValidationError';
  }
}

/**
 * Not found error
 */
export class NotFoundError extends PluginError<'KB_RUNTIME_RESOURCE_NOT_FOUND'> {
  constructor(message: string, details?: DetailsFor<'KB_RUNTIME_RESOURCE_NOT_FOUND'>) {
    super(message, 'KB_RUNTIME_RESOURCE_NOT_FOUND', details);
    this.name = 'NotFoundError';
  }
}

/**
 * Rate limit exceeded error
 */
export class RateLimitError extends PluginError<'KB_RUNTIME_RATE_LIMITED'> {
  constructor(
    message: string = 'Rate limit exceeded',
    public readonly retryAfterMs: number
  ) {
    super(message, 'KB_RUNTIME_RATE_LIMITED', { retryAfter: `${Math.ceil(retryAfterMs / 1000)}s` });
    this.name = 'RateLimitError';
  }
}

/**
 * Platform service error (e.g., LLM, cache, storage)
 */
export class PlatformError extends PluginError<'KB_HOST_ADAPTER_UNAVAILABLE'> {
  constructor(
    public readonly service: string,
    message: string,
    details?: Partial<DetailsFor<'KB_HOST_ADAPTER_UNAVAILABLE'>>
  ) {
    super(message, 'KB_HOST_ADAPTER_UNAVAILABLE', { slot: service, reason: message, ...details });
    this.name = 'PlatformError';
  }
}

/**
 * Check if an error is a PluginError
 */
export function isPluginError(error: unknown): error is PluginError<ErrorCode> {
  return error instanceof PluginError;
}
