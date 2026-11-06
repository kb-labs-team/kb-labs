import { z } from "zod";
import { schemaReferenceSchema } from "./api.schema";

export const commandContractSchema = z.object({
  id: z.string().min(1),
  description: z.string().optional(),
  input: schemaReferenceSchema.optional(),
  output: schemaReferenceSchema.optional(),
  produces: z.array(z.string().min(1)).optional(),
  consumes: z.array(z.string().min(1)).optional(),
  examples: z.array(z.string().min(1)).optional(),
});

export const commandContractMapSchema = z.record(commandContractSchema);
