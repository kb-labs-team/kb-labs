import { z } from 'zod';

export const workflowStepSchema = z.object({
  id: z.string().min(1),
  description: z.string().optional(),
  commandId: z.string().min(1).optional(),
  consumes: z.array(z.string().min(1)).optional(),
  produces: z.array(z.string().min(1)).optional()
});

export const workflowContractSchema = z.object({
  id: z.string().min(1),
  description: z.string().optional(),
  consumes: z.array(z.string().min(1)).optional(),
  produces: z.array(z.string().min(1)).optional(),
  steps: z.array(workflowStepSchema).optional()
});

export const workflowContractMapSchema = z.record(workflowContractSchema);

