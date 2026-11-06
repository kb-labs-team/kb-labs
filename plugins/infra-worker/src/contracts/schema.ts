import { z } from 'zod';

export const PrepareInfraInputSchema = z.object({
  sourceRef: z.string().optional(),
  basePath: z.string().optional(),
  createEnvironment: z.boolean().optional(),
  templateId: z.string().optional(),
  ttlMs: z.number().int().positive().optional(),
  captureSnapshot: z.boolean().optional(),
  namespace: z.string().optional(),
});

export const PrepareInfraOutputSchema = z.object({
  workspaceId: z.string(),
  environmentId: z.string().optional(),
  snapshotId: z.string().optional(),
});

export type PrepareInfraInput = z.infer<typeof PrepareInfraInputSchema>;
export type PrepareInfraOutput = z.infer<typeof PrepareInfraOutputSchema>;

export const CaptureSnapshotInputSchema = z.object({
  workspaceId: z.string().optional(),
  environmentId: z.string().optional(),
  namespace: z.string().optional(),
  sourcePath: z.string().optional(),
});

export const CaptureSnapshotOutputSchema = z.object({
  snapshotId: z.string(),
});

export type CaptureSnapshotInput = z.infer<typeof CaptureSnapshotInputSchema>;
export type CaptureSnapshotOutput = z.infer<typeof CaptureSnapshotOutputSchema>;

export const RestoreSnapshotInputSchema = z.object({
  snapshotId: z.string(),
  workspaceId: z.string().optional(),
  environmentId: z.string().optional(),
  targetPath: z.string().optional(),
  overwrite: z.boolean().optional(),
});

export const RestoreSnapshotOutputSchema = z.object({
  snapshotId: z.string(),
  restoredAt: z.string(),
});

export type RestoreSnapshotInput = z.infer<typeof RestoreSnapshotInputSchema>;
export type RestoreSnapshotOutput = z.infer<typeof RestoreSnapshotOutputSchema>;
