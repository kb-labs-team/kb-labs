/**
 * Schema Builders for KB Labs Plugins
 *
 * Optional helpers for common Zod validation patterns.
 * You can always use plain Zod - these are just conveniences for repetitive patterns.
 *
 * @example
 * ```typescript
 * import { schema } from '@kb-labs/shared-command-kit';
 *
 * const RequestSchema = schema.object({
 *   cwd: schema.cwd(),
 *   scope: schema.scopeId(),
 *   text: schema.text({ min: 1, max: 10000 }),
 *   mode: schema.enum(['instant', 'auto', 'thinking'], { default: 'auto' }),
 *   limit: schema.positiveInt({ max: 100, default: 10 }),
 * });
 * ```
 */

import { z } from 'zod';

/**
 * Current working directory path (optional string)
 * Commonly used in CLI and REST handlers
 *
 * @example
 * ```typescript
 * const schema = z.object({
 *   cwd: schema.cwd(),
 * });
 * // Equivalent to: cwd: z.string().optional()
 * ```
 */
export function cwd() {
  return z.string().optional().describe('Current working directory path');
}

/**
 * Scope identifier (required non-empty string)
 * Used for Mind RAG scopes, workflow scopes, etc.
 *
 * @example
 * ```typescript
 * const schema = z.object({
 *   scope: schema.scopeId(),
 * });
 * // Equivalent to: scope: z.string().min(1)
 * ```
 */
export function scopeId() {
  return z.string().min(1).describe('Scope identifier');
}

/**
 * Text string with optional length constraints
 *
 * @example
 * ```typescript
 * schema.text({ min: 1, max: 10000 })
 * // Equivalent to: z.string().min(1).max(10000)
 * ```
 */
export function text(options?: { min?: number; max?: number; default?: string }): z.ZodString | z.ZodDefault<z.ZodString> {
  let schema = z.string();

  if (options?.min !== undefined) {
    schema = schema.min(options.min);
  }

  if (options?.max !== undefined) {
    schema = schema.max(options.max);
  }

  if (options?.default !== undefined) {
    return schema.default(options.default).describe('Text string');
  }

  return schema.describe('Text string');
}

/**
 * Positive integer with optional constraints
 *
 * @example
 * ```typescript
 * schema.positiveInt({ max: 100, default: 10 })
 * // Equivalent to: z.number().int().positive().max(100).default(10)
 * ```
 */
export function positiveInt(options?: { min?: number; max?: number; default?: number }): z.ZodNumber | z.ZodDefault<z.ZodNumber> {
  let schema = z.number().int().positive();

  if (options?.min !== undefined) {
    schema = schema.min(options.min);
  }

  if (options?.max !== undefined) {
    schema = schema.max(options.max);
  }

  if (options?.default !== undefined) {
    return schema.default(options.default).describe('Positive integer');
  }

  return schema.describe('Positive integer');
}

/**
 * Non-negative integer (0 or positive)
 *
 * @example
 * ```typescript
 * schema.nonNegativeInt({ max: 100 })
 * // Equivalent to: z.number().int().min(0).max(100)
 * ```
 */
export function nonNegativeInt(options?: { max?: number; default?: number }): z.ZodNumber | z.ZodDefault<z.ZodNumber> {
  let schema = z.number().int().min(0);

  if (options?.max !== undefined) {
    schema = schema.max(options.max);
  }

  if (options?.default !== undefined) {
    return schema.default(options.default).describe('Non-negative integer');
  }

  return schema.describe('Non-negative integer');
}

/**
 * Enum with optional default value
 *
 * @example
 * ```typescript
 * schema.enum(['instant', 'auto', 'thinking'], { default: 'auto' })
 * // Equivalent to: z.enum(['instant', 'auto', 'thinking']).default('auto')
 * ```
 */
export function enumSchema<T extends [string, ...string[]]>(
  values: T,
  options?: { default?: T[number] }
) {
  const schema = z.enum(values);

  if (options?.default !== undefined) {
    return schema.default(options.default as T[number]);
  }

  return schema;
}

/**
 * Plugin ID (@kb-labs/package-name format)
 *
 * @example
 * ```typescript
 * schema.pluginId()
 * // Matches: @kb-labs/mind, @kb-labs/workflow, etc.
 * ```
 */
export function pluginId() {
  return z
    .string()
    .regex(/^@kb-labs\/[a-z][a-z0-9-]*$/, 'Must be in format @kb-labs/package-name')
    .describe('Plugin ID');
}

/**
 * Command ID (plugin:command format)
 *
 * @example
 * ```typescript
 * schema.commandId()
 * // Matches: mind:query, workflow:run, etc.
 * ```
 */
export function commandId() {
  return z
    .string()
    .regex(/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/, 'Must be in format plugin:command')
    .describe('Command ID');
}

/**
 * Artifact ID (plugin.artifact.id format)
 *
 * @example
 * ```typescript
 * schema.artifactId()
 * // Matches: mind.index.vector, workflow.run.result, etc.
 * ```
 */
export function artifactId() {
  return z
    .string()
    .regex(/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/, 'Must be in format plugin.artifact.id')
    .describe('Artifact ID');
}

/**
 * File path (string)
 * Optional with default to undefined
 *
 * @example
 * ```typescript
 * schema.filePath()
 * // Equivalent to: z.string()
 * ```
 */
export function filePath(options?: { optional?: boolean }) {
  const schema = z.string().describe('File path');

  if (options?.optional) {
    return schema.optional();
  }

  return schema;
}

/**
 * URL string
 *
 * @example
 * ```typescript
 * schema.url()
 * // Equivalent to: z.string().url()
 * ```
 */
export function url(options?: { optional?: boolean }) {
  const schema = z.string().url().describe('URL');

  if (options?.optional) {
    return schema.optional();
  }

  return schema;
}

/**
 * Email string
 *
 * @example
 * ```typescript
 * schema.email()
 * // Equivalent to: z.string().email()
 * ```
 */
export function email(options?: { optional?: boolean }) {
  const schema = z.string().email().describe('Email address');

  if (options?.optional) {
    return schema.optional();
  }

  return schema;
}

/**
 * UUID string
 *
 * @example
 * ```typescript
 * schema.uuid()
 * // Equivalent to: z.string().uuid()
 * ```
 */
export function uuid(options?: { optional?: boolean }) {
  const schema = z.string().uuid().describe('UUID');

  if (options?.optional) {
    return schema.optional();
  }

  return schema;
}

/**
 * ISO datetime string
 *
 * @example
 * ```typescript
 * schema.datetime()
 * // Equivalent to: z.string().datetime()
 * ```
 */
export function datetime(options?: { optional?: boolean }) {
  const schema = z.string().datetime().describe('ISO datetime');

  if (options?.optional) {
    return schema.optional();
  }

  return schema;
}

/**
 * JSON object (any valid JSON object)
 *
 * @example
 * ```typescript
 * schema.json()
 * // Equivalent to: z.record(z.string(), z.unknown())
 * ```
 */
export function json() {
  return z.record(z.string(), z.unknown()).describe('JSON object');
}

/**
 * Boolean with optional default
 *
 * @example
 * ```typescript
 * schema.boolean({ default: false })
 * // Equivalent to: z.boolean().default(false)
 * ```
 */
export function boolean(options?: { default?: boolean }) {
  const schema = z.boolean();

  if (options?.default !== undefined) {
    return schema.default(options.default);
  }

  return schema;
}

/**
 * Array of items with optional length constraints
 *
 * @example
 * ```typescript
 * schema.array(z.string(), { min: 1, max: 10 })
 * // Equivalent to: z.array(z.string()).min(1).max(10)
 * ```
 */
export function array<T extends z.ZodTypeAny>(
  itemSchema: T,
  options?: { min?: number; max?: number }
) {
  let schema = z.array(itemSchema);

  if (options?.min !== undefined) {
    schema = schema.min(options.min);
  }

  if (options?.max !== undefined) {
    schema = schema.max(options.max);
  }

  return schema;
}

/**
 * Object schema builder (alias for z.object)
 *
 * @example
 * ```typescript
 * schema.object({ name: z.string() })
 * // Equivalent to: z.object({ name: z.string() })
 * ```
 */
export function object<T extends z.ZodRawShape>(shape: T) {
  return z.object(shape);
}

/**
 * Export schema builders namespace
 *
 * @example
 * ```typescript
 * import { schema } from '@kb-labs/shared-command-kit';
 *
 * const MySchema = schema.object({
 *   cwd: schema.cwd(),
 *   scope: schema.scopeId(),
 *   text: schema.text({ min: 1, max: 10000 }),
 * });
 * ```
 */
export const schema = {
  // Path and ID builders
  cwd,
  scopeId,
  pluginId,
  commandId,
  artifactId,
  filePath,

  // String builders
  text,
  url,
  email,
  uuid,
  datetime,

  // Number builders
  positiveInt,
  nonNegativeInt,

  // Other builders
  enum: enumSchema,
  boolean,
  json,
  array,
  object,
};
