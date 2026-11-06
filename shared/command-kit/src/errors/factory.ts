import { createProductErrorEnvelope } from '@kb-labs/core-platform/error-envelope';
import { ProductPluginError } from '@kb-labs/plugin-contracts';

/**
 * Error Factory for KB Labs Plugins
 *
 * Optional helper for defining plugin errors without boilerplate.
 * You can always use standard Error classes - this is just convenience.
 *
 * @example
 * ```typescript
 * import { defineError } from '@kb-labs/shared-command-kit';
 *
 * export const MindError = defineError('MIND', {
 *   ValidationFailed: { code: 400, message: 'Validation failed' },
 *   IndexNotFound: { code: 404, message: (scope: string) => `Index '${scope}' not found` },
 *   QueryFailed: { code: 500, message: 'Query execution failed' },
 * });
 *
 * // Usage:
 * throw new MindError.IndexNotFound('default');
 * throw new MindError.ValidationFailed({ details: { field: 'cwd' } });
 * ```
 */

/**
 * Error definition with HTTP code and message
 */
export interface ErrorDefinition {
  /** HTTP status code (400, 404, 500, etc.) */
  code: number;
  /** Error message - can be string or function for parameterized messages */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  message: string | ((...args: any[]) => string);
  /** Actionable next step required by ADR-0049 for product error codes. */
  hint: string;
  /** Optional additional details */
  details?: Record<string, string>;
}

/**
 * Error definitions map
 */
export type ErrorDefinitions = Record<string, ErrorDefinition>;

/**
 * Type for error constructor created by defineError
 */
type ErrorConstructor<TArgs extends unknown[] = unknown[]> = {
  new (details?: Record<string, string>): ProductPluginError;
  new (...args: TArgs): ProductPluginError;
};

/**
 * Type for error namespace created by defineError
 */
type ErrorNamespace<TDefs extends ErrorDefinitions> = {
  [K in keyof TDefs]: ErrorConstructor;
} & {
  /** Check if error is from this namespace */
  is(error: unknown): error is ProductPluginError;
  /** Check if error has specific error code */
  hasCode(error: unknown, code: keyof TDefs): boolean;
};

/**
 * Define a namespace of plugin errors
 *
 * @param prefix - Error code prefix (e.g., 'MIND', 'WORKFLOW')
 * @param definitions - Error definitions map
 * @returns Error namespace with error constructors
 *
 * @example
 * ```typescript
 * export const MindError = defineError('MIND', {
 *   IndexNotFound: {
 *     code: 404,
 *     message: (scope: string) => `Index '${scope}' not found`
 *   },
 *   QueryFailed: {
 *     code: 500,
 *     message: 'Query execution failed'
 *   },
 * });
 *
 * // Throw with template params
 * throw new MindError.IndexNotFound('default');
 * // Error message: "Index 'default' not found"
 *
 * // Throw with details
 * throw new MindError.QueryFailed({
 *   details: { query: 'test', reason: 'timeout' }
 * });
 * ```
 */
export function defineError<TDefs extends ErrorDefinitions>(
  prefix: string,
  definitions: TDefs
): ErrorNamespace<TDefs> {
  const errorNamespace: Record<string, unknown> = {};

  // Create error constructor for each definition
  for (const [key, def] of Object.entries(definitions)) {
    const errorCode = `${prefix}_${key.toUpperCase()}`;

    // Create error class
    class DefinedError extends ProductPluginError {
      constructor(...args: unknown[]) {
        const { message, details } = buildMessageAndDetails(def, args);
        const envelope = createProductErrorEnvelope({
          code: errorCode,
          message,
          details,
          hint: def.hint,
          retryable: def.code >= 500,
        });
        super(message, envelope.code, def.code, details, envelope.hint);
        this.name = `${prefix}Error`;
      }
    }

    errorNamespace[key] = DefinedError;
  }

  // Add helper methods
  errorNamespace.is = (error: unknown): error is ProductPluginError => {
    return error instanceof ProductPluginError && error.code.startsWith(prefix + '_');
  };

  errorNamespace.hasCode = (error: unknown, code: keyof TDefs): boolean => {
    const errorCode = `${prefix}_${String(code).toUpperCase()}`;
    return error instanceof ProductPluginError && error.code === errorCode;
  };

  return errorNamespace as ErrorNamespace<TDefs>;
}

/**
 * Build error message and details from definition and constructor args
 */
function buildMessageAndDetails(
  def: ErrorDefinition,
  args: unknown[]
): { message: string; details?: Record<string, string> } {
  let message: string;
  let details: Record<string, string> | undefined;

  if (typeof def.message === 'function') {
    // Template message - args are template params
    const lastArg = args[args.length - 1];

    // Check if last arg is details object (has 'details' key)
    const hasDetails = lastArg && typeof lastArg === 'object' && 'details' in lastArg;

    if (hasDetails) {
      // Last arg is details, rest are template params
      const templateArgs = args.slice(0, -1);
      message = def.message(...templateArgs);
      details = { ...def.details, ...(lastArg as { details?: Record<string, string> }).details };
    } else {
      // All args are template params
      message = def.message(...args);
      details = def.details;
    }
  } else {
    // Static message
    message = def.message;

    // First arg can be details object
    if (args.length > 0 && typeof args[0] === 'object' && args[0] !== null) {
      details = { ...def.details, ...(args[0] as { details?: Record<string, string> }).details };
    } else {
      details = def.details;
    }
  }

  return { message, details };
}

/**
 * Common error definitions that can be reused across plugins
 */
export const commonErrors = {
  /**
   * Validation error (400)
   */
  ValidationFailed: {
    code: 400,
    message: 'Validation failed',
    hint: 'Correct the invalid input, then retry the request.',
  },

  /**
   * Resource not found (404)
   */
  NotFound: {
    code: 404,
    message: (resource: string) => `${resource} not found`,
    hint: 'Check the resource name and confirm it exists before retrying.',
  },

  /**
   * Unauthorized access (401)
   */
  Unauthorized: {
    code: 401,
    message: 'Unauthorized',
    hint: 'Authenticate with an identity allowed to perform this operation.',
  },

  /**
   * Forbidden access (403)
   */
  Forbidden: {
    code: 403,
    message: 'Forbidden',
    hint: 'Use an identity with permission to perform this operation.',
  },

  /**
   * Internal server error (500)
   */
  InternalError: {
    code: 500,
    message: 'Internal server error',
    hint: 'Retry the request; if it persists, contact the plugin maintainer with the correlation ID.',
  },

  /**
   * Service unavailable (503)
   */
  ServiceUnavailable: {
    code: 503,
    message: (service: string) => `Service '${service}' is unavailable`,
    hint: 'Check the service health and retry after it is available.',
  },

  /**
   * Timeout error (504)
   */
  Timeout: {
    code: 504,
    message: (operation: string) => `Operation '${operation}' timed out`,
    hint: 'Retry the operation; if it continues to time out, inspect the service logs.',
  },

  /**
   * Conflict error (409)
   */
  Conflict: {
    code: 409,
    message: (resource: string) => `${resource} already exists`,
    hint: 'Choose a different resource name or remove the conflicting resource, then retry.',
  },
} satisfies ErrorDefinitions;
