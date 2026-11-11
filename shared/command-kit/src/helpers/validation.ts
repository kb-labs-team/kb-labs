/**
 * @module @kb-labs/shared-command-kit/helpers/validation
 * Validation helpers with common schemas and Zod integration.
 *
 * Provides ready-to-use validation schemas and helpers for common use cases.
 */

import { z } from 'zod';
import type { DetailsFor } from '@kb-labs/core-platform';

/**
 * Validation error with formatted message.
 */
export class ValidationError extends Error {
  readonly code = 'KB_RUNTIME_INPUT_INVALID' as const;
  readonly details: DetailsFor<'KB_RUNTIME_INPUT_INVALID'>;

  constructor(
    message: string,
    public readonly issues?: Array<{ path: string; message: string }>
  ) {
    super(message);
    this.name = 'ValidationError';
    const fields = [...new Set((issues ?? []).map((issue) => issue.path || 'value'))];
    this.details = fields.length > 0 ? { field: fields.join(', ') } : {};
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// COMMON SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Common validation schemas for reuse across plugins.
 */
export const schemas = {
  /**
   * NPM package name (scoped or unscoped).
   * @example "@kb-labs/plugin-template", "lodash"
   */
  packageName: z.string().regex(/^(@[\w-]+\/)?[\w-]+$/, 'Invalid package name'),

  /**
   * Scoped NPM package name (must start with @).
   * @example "@kb-labs/plugin-template"
   */
  scopedPackageName: z.string().regex(/^@[\w-]+\/[\w-]+$/, 'Invalid scoped package name'),

  /**
   * Semantic version (semver).
   * @example "1.0.0", "2.1.3-beta.1"
   */
  semver: z.string().regex(/^\d+\.\d+\.\d+(-[\w.]+)?$/, 'Invalid semver'),

  /**
   * Email address.
   */
  email: z.string().email('Invalid email address'),

  /**
   * HTTP/HTTPS URL.
   */
  url: z.string().url('Invalid URL'),

  /**
   * GitHub repository URL.
   * @example "https://github.com/owner/repo"
   */
  githubUrl: z
    .string()
    .regex(/^https:\/\/github\.com\/[\w-]+\/[\w-]+$/, 'Invalid GitHub URL'),

  /**
   * File path (Unix-style).
   * @example "src/index.ts", "path/to/file.json"
   */
  filePath: z.string().regex(/^[\w\-./]+$/, 'Invalid file path'),

  /**
   * Non-empty string (trimmed).
   */
  nonEmptyString: z.string().trim().min(1, 'String cannot be empty'),

  /**
   * Positive integer.
   */
  positiveInt: z.number().int().positive('Must be positive integer'),

  /**
   * Non-negative integer (including 0).
   */
  nonNegativeInt: z.number().int().min(0, 'Must be non-negative integer'),

  /**
   * Port number (1-65535).
   */
  port: z.number().int().min(1).max(65535, 'Invalid port number'),

  /**
   * UUID v4.
   */
  uuid: z.string().uuid('Invalid UUID'),

  /**
   * ISO 8601 date string.
   * @example "2025-12-05T12:00:00Z"
   */
  isoDate: z.string().datetime('Invalid ISO 8601 date'),

  /**
   * JSON string (can be parsed).
   */
  jsonString: z.string().refine(
    (val) => {
      try {
        JSON.parse(val);
        return true;
      } catch {
        return false;
      }
    },
    { message: 'Invalid JSON string' }
  ),

  /**
   * Hexadecimal color code.
   * @example "#FF5733", "#FFF"
   */
  hexColor: z.string().regex(/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/, 'Invalid hex color'),

  /**
   * Tenant ID (alphanumeric, dash, underscore).
   * @example "default", "acme-corp", "tenant_123"
   */
  tenantId: z.string().regex(/^[\w-]+$/, 'Invalid tenant ID'),

  /**
   * Plugin ID (scoped package name).
   * @example "@kb-labs/plugin-template"
   */
  pluginId: z.string().regex(/^@[\w-]+\/[\w-]+$/, 'Invalid plugin ID'),
};

// ═══════════════════════════════════════════════════════════════════════════
// VALIDATION FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Format Zod error into readable message.
 */
function formatZodError(error: z.ZodError): string {
  const issues = error.issues
    .map((issue) => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('\n  ');

  return `Validation failed:\n  ${issues}`;
}

/**
 * Validate data against a Zod schema.
 * Throws ValidationError with formatted message on failure.
 *
 * @param schema - Zod schema
 * @param data - Data to validate
 * @returns Validated data (typed)
 * @throws {ValidationError} If validation fails
 *
 * @example
 * ```typescript
 * const userSchema = z.object({
 *   name: z.string(),
 *   email: schemas.email,
 * });
 *
 * const user = validateInput(userSchema, rawInput);
 * // user is typed as { name: string; email: string }
 * ```
 */
export function validateInput<T>(schema: z.Schema<T>, data: unknown): T {
  try {
    return schema.parse(data);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issues = error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      }));
      throw new ValidationError(formatZodError(error), issues);
    }
    throw error;
  }
}

/**
 * Safely validate data against a schema.
 * Returns success/failure result instead of throwing.
 *
 * @param schema - Zod schema
 * @param data - Data to validate
 * @returns Validation result
 *
 * @example
 * ```typescript
 * const result = safeValidate(schemas.email, input);
 *
 * if (result.success) {
 *   console.log('Valid email:', result.data);
 * } else {
 *   console.error('Invalid:', result.error);
 * }
 * ```
 */
export function safeValidate<T>(
  schema: z.Schema<T>,
  data: unknown
): { success: true; data: T } | { success: false; error: string; issues: Array<{ path: string; message: string }> } {
  const result = schema.safeParse(data);

  if (result.success) {
    return { success: true, data: result.data };
  }

  const issues = result.error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));

  return {
    success: false,
    error: formatZodError(result.error),
    issues,
  };
}

/**
 * Validate schema against data (general purpose).
 * Use this for any data validation, not just flags.
 *
 * @param schema - Zod schema
 * @param data - Data to validate
 * @returns Validated data (typed)
 * @throws {ValidationError} If validation fails
 *
 * @example
 * ```typescript
 * const configSchema = z.object({
 *   output: z.string().optional(),
 *   force: z.boolean().default(false),
 * });
 *
 * const validConfig = validateSchema(configSchema, rawConfig);
 * ```
 */
export function validateSchema<T>(schema: z.Schema<T>, data: unknown): T {
  try {
    return validateInput(schema, data);
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new ValidationError(`Validation failed: ${error.message}`, error.issues);
    }
    throw error;
  }
}

/**
 * Validate array of items against schema.
 * Returns validated items and any errors.
 *
 * @param schema - Zod schema for single item
 * @param items - Array of items
 * @returns Validated items and errors
 *
 * @example
 * ```typescript
 * const { valid, invalid } = validateArray(schemas.email, emails);
 *
 * console.log(`${valid.length} valid, ${invalid.length} invalid`);
 * for (const { index, error } of invalid) {
 *   console.error(`Item ${index}: ${error}`);
 * }
 * ```
 */
export function validateArray<T>(
  schema: z.Schema<T>,
  items: unknown[]
): {
  valid: T[];
  invalid: Array<{ index: number; item: unknown; error: string }>;
} {
  const valid: T[] = [];
  const invalid: Array<{ index: number; item: unknown; error: string }> = [];

  for (let i = 0; i < items.length; i++) {
    const result = safeValidate(schema, items[i]);
    if (result.success) {
      valid.push(result.data);
    } else {
      invalid.push({ index: i, item: items[i], error: result.error });
    }
  }

  return { valid, invalid };
}

// ═══════════════════════════════════════════════════════════════════════════
// CUSTOM VALIDATORS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check if value is a valid package name.
 */
export function isPackageName(value: unknown): value is string {
  return schemas.packageName.safeParse(value).success;
}

/**
 * Check if value is a valid semver.
 */
export function isSemver(value: unknown): value is string {
  return schemas.semver.safeParse(value).success;
}

/**
 * Check if value is a valid email.
 */
export function isEmail(value: unknown): value is string {
  return schemas.email.safeParse(value).success;
}

/**
 * Check if value is a valid URL.
 */
export function isUrl(value: unknown): value is string {
  return schemas.url.safeParse(value).success;
}

/**
 * Check if value is a valid UUID.
 */
export function isUUID(value: unknown): value is string {
  return schemas.uuid.safeParse(value).success;
}

// ═══════════════════════════════════════════════════════════════════════════
// COMMON PATTERNS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create optional string field with default.
 *
 * @example
 * ```typescript
 * const schema = z.object({
 *   format: optionalString('json'), // defaults to 'json' if not provided
 * });
 * ```
 */
export function optionalString(defaultValue: string) {
  return z.string().default(defaultValue);
}

/**
 * Create optional boolean field with default.
 *
 * @example
 * ```typescript
 * const schema = z.object({
 *   force: optionalBoolean(false), // defaults to false if not provided
 * });
 * ```
 */
export function optionalBoolean(defaultValue: boolean) {
  return z.boolean().default(defaultValue);
}

/**
 * Create optional number field with default.
 *
 * @example
 * ```typescript
 * const schema = z.object({
 *   timeout: optionalNumber(5000), // defaults to 5000 if not provided
 * });
 * ```
 */
export function optionalNumber(defaultValue: number) {
  return z.number().default(defaultValue);
}

/**
 * Create enum schema from array of values.
 *
 * @example
 * ```typescript
 * const formatSchema = enumFromArray(['json', 'yaml', 'toml'] as const);
 * // Type: 'json' | 'yaml' | 'toml'
 * ```
 */
export function enumFromArray<T extends readonly [string, ...string[]]>(values: T) {
  return z.enum(values);
}
