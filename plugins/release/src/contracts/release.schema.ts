import { z } from 'zod';

export const ReleasePlanSchema = z
  .object({
    packages: z.array(
      z.object({
        name: z.string(),
        path: z.string(),
        currentVersion: z.string(),
        nextVersion: z.string(),
        bump: z.enum(['patch', 'minor', 'major', 'auto'] as const),
        isPublished: z.boolean(),
        dependencies: z.array(z.string()).optional(),
      })
    ),
    strategy: z.string(),
    registry: z.string(),
    rollbackEnabled: z.boolean(),
    channel: z.enum(['stable', 'canary'] as const),
  })
  .passthrough();

export const ReleaseReportSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    ts: z.string(),
    context: z
      .object({
        repo: z.string(),
        cwd: z.string(),
        branch: z.string(),
        profile: z.string().optional(),
        dryRun: z.boolean().optional(),
      })
      .passthrough(),
    stage: z.enum(['planning', 'checking', 'versioning', 'publishing', 'verifying', 'rollback'] as const),
    plan: ReleasePlanSchema.optional(),
    result: z
      .object({
        ok: z.boolean(),
        version: z.string().optional(),
        published: z.array(z.string()).optional(),
        changelog: z.string().optional(),
        checks: z.record(z.string(), z.any()).optional(),
        timingMs: z.number(),
        errors: z.array(z.string()).optional(),
      })
      .passthrough(),
  })
  .passthrough();

export type ReleasePlanContract = z.infer<typeof ReleasePlanSchema>;
export type ReleaseReportContract = z.infer<typeof ReleaseReportSchema>;


