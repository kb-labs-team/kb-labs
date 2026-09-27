/**
 * @module @kb-labs/core-runtime/config-schemas
 *
 * Zod schemas for platform config validation.
 * Applied at load time to catch misconfiguration early.
 *
 * ExecutionConfig is the most complex config section with security-sensitive
 * values (secrets, URLs, JWT keys), so it is validated in detail. The
 * remaining platform sections (`platform`, `platform.adapters`,
 * `platform.adapterOptions`, `core`, and the top-level shape of the user
 * config file) have schemas below; they are deliberately permissive about keys
 * they do not own (product sections, custom adapter slots) and strict about
 * value types. `kb config set` validates every write against
 * `PlatformUserConfigSchema` (ADR-0047, stage 5.3).
 */

import { z } from 'zod';
import { flattenZodIssues } from '@kb-labs/core-config';

// ── ContainerExecutionConfig ──────────────────────────────────────────────────

export const ContainerExecutionConfigSchema = z.object({
  /** URL for the Gateway's internal dispatch endpoint (used by loader.ts RoutingBackend transport). */
  gatewayDispatchUrl: z.string().url({
    message: 'execution.container.gatewayDispatchUrl must be a valid URL (e.g. "http://localhost:4000/internal/dispatch")',
  }),
  /** Internal secret for the dispatch endpoint. */
  gatewayInternalSecret: z.string().min(1, {
    message: 'execution.container.gatewayInternalSecret must not be empty. Use ${ENV_VAR} to reference an environment variable.',
  }),
  // gatewayWsUrl and gatewayJwtSecret moved to adapterOptions.environment.gateway
  // (adapter-owned: DockerEnvironmentAdapter injects them during reserve()+start())
  image: z.string().optional(),
  pullPolicy: z.enum(['Always', 'IfNotPresent', 'Never']).optional(),
  dockerFlags: z.array(z.string()).optional(),
});

// ── ExecutionRetryConfig ──────────────────────────────────────────────────────

export const ExecutionRetryConfigSchema = z.object({
  maxAttempts: z.number().int().min(1).optional(),
  initialDelayMs: z.number().int().nonnegative().optional(),
  backoffMultiplier: z.number().positive().optional(),
  maxDelayMs: z.number().int().nonnegative().optional(),
  onlyRetryable: z.boolean().optional(),
});

// ── ExecutionConfig ───────────────────────────────────────────────────────────

export const ExecutionConfigSchema = z.object({
  mode: z.enum(['auto', 'in-process', 'subprocess', 'worker-pool', 'remote', 'container']).optional(),

  workerPool: z.object({
    min: z.number().int().nonnegative().optional(),
    max: z.number().int().positive().optional(),
    maxRequestsPerWorker: z.number().int().positive().optional(),
    maxUptimeMsPerWorker: z.number().int().positive().optional(),
    maxConcurrentPerPlugin: z.number().int().positive().optional(),
    warmup: z.object({
      mode: z.enum(['none', 'top-n', 'marked']).optional(),
      topN: z.number().int().positive().optional(),
      maxHandlers: z.number().int().positive().optional(),
    }).optional(),
  }).optional(),

  remote: z.object({
    endpoint: z.string().url().optional(),
  }).optional(),

  container: ContainerExecutionConfigSchema.optional(),

  retry: ExecutionRetryConfigSchema.optional(),
}).superRefine((cfg, ctx) => {
  // If mode=container, container config must be present
  if (cfg.mode === 'container' && !cfg.container) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['container'],
      message: 'execution.container is required when mode is "container"',
    });
  }

  // If mode=remote, remote.endpoint must be present
  if (cfg.mode === 'remote' && !cfg.remote?.endpoint) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['remote', 'endpoint'],
      message: 'execution.remote.endpoint is required when mode is "remote"',
    });
  }
});

export type ExecutionConfigInput = z.input<typeof ExecutionConfigSchema>;
export type ExecutionConfigParsed = z.output<typeof ExecutionConfigSchema>;

/**
 * Validate ExecutionConfig at startup.
 * Throws a descriptive error on misconfiguration.
 */
export function validateExecutionConfig(raw: unknown): ExecutionConfigParsed {
  const result = ExecutionConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  • ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid execution config:\n${issues}`);
  }
  return result.data;
}

// ── Platform user config (ADR-0047) ───────────────────────────────────────────

/**
 * Adapter binding: a package name, a list of package names (first is the
 * primary), or `null` for the NoOp adapter. Mirrors `AdapterValue`.
 */
export const AdapterValueSchema = z.union(
  [z.string().min(1), z.array(z.string().min(1)).min(1), z.null()],
  { errorMap: () => ({ message: 'must be an adapter package name, a non-empty list of them, or null' }) },
);

/**
 * Adapter slots the platform (or its installer) knows about. The schema stays
 * open for custom slots, but a near-miss of one of these names is reported as
 * a typo by `kb config set` ("did you mean …").
 */
export const KNOWN_ADAPTER_SLOTS = [
  'analytics',
  'cache',
  'documentDatabase',
  'embeddings',
  'environment',
  'eventBus',
  'kvStore',
  'llm',
  'logPersistence',
  'logRingBuffer',
  'logger',
  'notifier',
  'serviceTransport',
  'snapshot',
  'storage',
  'vectorStore',
  'workspace',
] as const;

const knownAdapterSlotShape = Object.fromEntries(
  KNOWN_ADAPTER_SLOTS.map((slot) => [slot, AdapterValueSchema.optional()]),
);

/** `platform.adapters`: slot name -> adapter package(s) or null. Custom slots are allowed. */
export const PlatformAdaptersSchema = z.object(knownAdapterSlotShape).catchall(AdapterValueSchema);

/**
 * `platform.adapterOptions`: options per adapter slot / adapter id. Each entry
 * must be an object; its contents are adapter-owned and validated against the
 * adapter manifest `configSchema` when the adapter is installed.
 */
export const PlatformAdapterOptionsSchema = z.record(
  z.string().min(1),
  z.record(z.string(), z.unknown(), { invalid_type_error: 'adapter options must be an object' }),
);

const positiveInt = z.number().int().positive();

/** `core`: platform feature switches. Sub-sections not listed are passed through. */
export const CoreFeaturesConfigSchema = z
  .object({
    resources: z.object({}).passthrough().optional(),
    jobs: z
      .object({ maxConcurrent: positiveInt.optional(), pollInterval: positiveInt.optional() })
      .passthrough()
      .optional(),
    workflows: z
      .object({ maxConcurrent: positiveInt.optional(), defaultTimeout: positiveInt.optional() })
      .passthrough()
      .optional(),
    resourceBroker: z.object({ distributed: z.boolean().optional() }).passthrough().optional(),
    privacy: z.object({ enabled: z.boolean().optional() }).passthrough().optional(),
  })
  .passthrough();

/**
 * The `platform` section of the user config file: either the bare platform
 * directory (installed-mode shorthand) or the structured form.
 */
export const PlatformSectionSchema = z.union([
  z.string().min(1),
  z
    .object({
      dir: z.string().min(1).optional(),
      adapters: PlatformAdaptersSchema.optional(),
      adapterOptions: PlatformAdapterOptionsSchema.optional(),
      core: CoreFeaturesConfigSchema.optional(),
      execution: ExecutionConfigSchema.optional(),
    })
    .passthrough(),
]);

/**
 * Whole user config file (`kb.config.jsonc`). Top-level product sections
 * (`plugins`, `gateway`, `profiles`, …) belong to their owners and pass
 * through; only the platform-owned sections are typed here.
 */
export const PlatformUserConfigSchema = z
  .object({
    platform: PlatformSectionSchema.optional(),
    adapterOptions: PlatformAdapterOptionsSchema.optional(),
  })
  .passthrough();

export type PlatformUserConfig = z.output<typeof PlatformUserConfigSchema>;

export interface PlatformConfigIssue {
  /** Dotted path of the offending value (empty for the document root). */
  path: string;
  message: string;
}

/** Validate a parsed user config document; returns every issue with its field path. */
export function validatePlatformUserConfig(raw: unknown): PlatformConfigIssue[] {
  const result = PlatformUserConfigSchema.safeParse(raw);
  if (result.success) {
    return [];
  }
  return flattenZodIssues(result.error);
}
