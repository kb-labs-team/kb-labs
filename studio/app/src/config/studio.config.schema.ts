/**
 * @module @kb-labs/studio-app/config/schema
 * Zod validation schema for Studio configuration
 *
 * This provides runtime validation of environment variables and configuration.
 * Ensures that invalid config fails fast at startup instead of causing runtime errors.
 */

import { z } from 'zod';

/**
 * Data source mode schema
 */
const DataSourceModeSchema = z.enum(['mock', 'http'], {
  error: 'dataSourceMode must be either "mock" or "http"',
});

/**
 * Features configuration schema
 */
const FeaturesSchema = z.object({
  enableDevlink: z.boolean(),
  enableMind: z.boolean(),
  enableAnalytics: z.boolean(),
  sse: z.boolean(),
  analytics: z.boolean(),
});

/**
 * Events configuration schema
 */
const EventsSchema = z.object({
  baseUrl: z.string(),
  registryPath: z.string(),
  registryUrl: z.string().url().or(z.string().startsWith('/')),
  retryDelays: z.array(z.number().int().positive()).min(1),
  token: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

/**
 * Complete Studio configuration schema
 */
export const StudioConfigSchema = z.object({
  dataSourceMode: DataSourceModeSchema,
  apiBaseUrl: z.string().min(1, 'apiBaseUrl is required'),
  /** Bearer token sent to Gateway on every request. Optional — omit when connecting directly to REST API. */
  gatewayToken: z.string().optional(),
  features: FeaturesSchema,
  events: EventsSchema,
});

/**
 * TypeScript type inferred from schema
 */
export type StudioConfig = z.infer<typeof StudioConfigSchema>;

/**
 * Validates studio configuration at runtime
 * Throws ZodError if configuration is invalid
 *
 * @param config - Raw configuration object
 * @returns Validated and typed configuration
 * @throws {z.ZodError} If configuration is invalid
 */
export function validateStudioConfig(config: unknown): StudioConfig {
  return StudioConfigSchema.parse(config);
}

/**
 * Validates studio configuration and returns safe result
 *
 * @param config - Raw configuration object
 * @returns Validation result with typed data or error
 */
export function safeValidateStudioConfig(config: unknown): {
  success: boolean;
  data?: StudioConfig;
  error?: z.ZodError;
} {
  const result = StudioConfigSchema.safeParse(config);

  if (result.success) {
    return { success: true, data: result.data };
  }

  return { success: false, error: result.error };
}
