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
import { flattenZodIssues, registerZodEnumIssueHint } from '@kb-labs/core-config';
import { createErrorEnvelope, ErrorEnvelopeError } from '@kb-labs/core-platform';
import { RESOLVED_EXECUTION_MODES, ROADMAP_EXECUTION_MODES } from '@kb-labs/core-contracts';

// ── ExecutionRetryConfig ──────────────────────────────────────────────────────

export const ExecutionRetryConfigSchema = z.object({
  maxAttempts: z.number().int().min(1).optional(),
  initialDelayMs: z.number().int().nonnegative().optional(),
  backoffMultiplier: z.number().positive().optional(),
  maxDelayMs: z.number().int().nonnegative().optional(),
  onlyRetryable: z.boolean().optional(),
});

// ── ExecutionConfig ───────────────────────────────────────────────────────────

const SUPPORTED_EXECUTION_MODES = ['auto', ...RESOLVED_EXECUTION_MODES] as const;
const EXECUTION_MODE_HINT = `Supported modes are ${SUPPORTED_EXECUTION_MODES.join(', ')}. Run \`kb config set platform.execution.mode in-process --scope platform\`.`;

registerZodEnumIssueHint(SUPPORTED_EXECUTION_MODES, (issue) => (
  isRoadmapExecutionMode(issue.received) ? EXECUTION_MODE_HINT : undefined
));

const executionModeErrorMap: z.ZodErrorMap = (issue, ctx) => {
  if (issue.code === z.ZodIssueCode.invalid_enum_value) {
    return {
      message: isRoadmapExecutionMode(issue.received)
        ? 'remote execution is not supported in this release'
        : ctx.defaultError,
    };
  }
  return { message: ctx.defaultError };
};

function isRoadmapExecutionMode(value: unknown): boolean {
  return ROADMAP_EXECUTION_MODES.some((mode) => mode === value);
}

export const ExecutionConfigSchema = z.object({
  mode: z.enum(SUPPORTED_EXECUTION_MODES, { errorMap: executionModeErrorMap }).optional(),

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

  workspaceAgent: z.object({
    enabled: z.boolean(),
    internalSecret: z.string().min(1),
    fallback: z.enum(['local', 'error']).optional(),
  }).strict().optional(),

  retry: ExecutionRetryConfigSchema.optional(),
}).strict();

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

export const DeploymentTopologySchema = z.enum(['local', 'cloud', 'k8s']);
export const DeploymentConfigSchema = z.object({ topology: DeploymentTopologySchema }).strict();
export type DeploymentTopology = z.output<typeof DeploymentTopologySchema>;

export function resolveDeploymentTopology(raw: unknown): DeploymentTopology {
  const result = PlatformUserConfigSchema.safeParse(raw);
  const platform = result.success && typeof result.data.platform === 'object'
    ? result.data.platform
    : undefined;
  const topology = platform?.deployment?.topology;
  if (!topology) {
    throw new ErrorEnvelopeError(createErrorEnvelope('KB_DEPLOYMENT_TOPOLOGY_REQUIRED'));
  }
  return topology;
}

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
      mode: z.enum(["development", "production"]).optional(),
      adapters: PlatformAdaptersSchema.optional(),
      adapterOptions: PlatformAdapterOptionsSchema.optional(),
      deployment: DeploymentConfigSchema.optional(),
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
  hint?: string;
}

/** Validate a parsed user config document; returns every issue with its field path. */
export function validatePlatformUserConfig(raw: unknown): PlatformConfigIssue[] {
  const result = PlatformUserConfigSchema.safeParse(raw);
  if (result.success) {
    return [];
  }
  return flattenZodIssues(result.error);
}
