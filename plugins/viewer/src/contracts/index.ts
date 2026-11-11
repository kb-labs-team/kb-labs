import { z } from 'zod';

export const architectureNodeSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  level: z.enum(['C1', 'C2', 'C3', 'C4']),
  summary: z.string().optional(),
  parent: z.string().optional(),
  children: z.array(z.string()).default([]),
  diagram: z.string().optional(),
  documents: z.array(z.string()).default([]),
  caseRefs: z.array(z.string()).default([]),
});

export const architectureIndexSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  title: z.string().min(1),
  root: z.string().min(1),
  nodes: z.array(architectureNodeSchema),
});

export const viewerFileEntrySchema = z.object({
  path: z.string(),
  name: z.string(),
  kind: z.enum(['directory', 'markdown', 'diagram', 'pdf', 'office', 'other']),
  size: z.number().nonnegative().optional(),
});

export type ArchitectureNode = z.infer<typeof architectureNodeSchema>;
export type ArchitectureIndex = z.infer<typeof architectureIndexSchema>;
export type ViewerFileEntry = z.infer<typeof viewerFileEntrySchema>;
