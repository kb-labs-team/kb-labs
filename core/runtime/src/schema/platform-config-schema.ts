/**
 * @module @kb-labs/core-runtime/schema/platform-config-schema
 *
 * Minimal JSON Schema for the merged `PlatformConfig`, used after overlay
 * application to catch structural breakage (e.g. an overlay setting
 * `adapters: "string"` instead of an object).
 *
 * Intentionally permissive on sub-property contents (`additionalProperties:
 * true`) so that adding new adapter slots or new core feature flags does not
 * require schema updates. The schema only enforces top-level types.
 *
 * Registered as a side-effect on module load via `registerProductSchema`.
 */

import { registerProductSchema } from '@kb-labs/core-config';

export const PLATFORM_CONFIG_PRODUCT = 'platform' as const;

export const PLATFORM_CONFIG_SCHEMA = {
  type: 'object',
  properties: {
    platform: { type: 'object', additionalProperties: true },
    adapters: { type: 'object', additionalProperties: true },
    adapterOptions: { type: 'object', additionalProperties: true },
    core: { type: 'object', additionalProperties: true },
    execution: { type: 'object', additionalProperties: true },
    deployment: {
      type: 'object',
      properties: { topology: { enum: ['local', 'cloud', 'k8s'] } },
      required: ['topology'],
      additionalProperties: false,
    },
  },
  additionalProperties: true,
} as const;

registerProductSchema(PLATFORM_CONFIG_PRODUCT, PLATFORM_CONFIG_SCHEMA as unknown as Record<string, unknown>);
