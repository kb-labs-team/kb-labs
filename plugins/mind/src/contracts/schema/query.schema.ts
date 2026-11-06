/**
 * `query` (agent) wire contract. Response is the frozen `AgentResponse`.
 */

import { z } from 'zod';
import { AgentQueryModeSchema } from './agent.schema';
import { SnippetModeSchema } from './search.schema';

export const QueryRequestSchema = z.object({
  text: z.string().min(1),
  indexId: z.string().optional(),
  mode: AgentQueryModeSchema.optional(),
  snippet: SnippetModeSchema.optional(),
});
export type QueryRequest = z.infer<typeof QueryRequestSchema>;

// The query (`ask`) response is the `AgentResponse` — exported from agent.schema.
