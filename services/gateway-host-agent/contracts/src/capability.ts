import { z } from 'zod';

export const CapabilitySchema = z.enum(['filesystem', 'git', 'editor-context']);
export type Capability = z.infer<typeof CapabilitySchema>;

/** A call dispatched from Gateway → Host Agent for a capability */
export const CapabilityCallSchema = z.object({
  type: z.literal('call'),
  requestId: z.string(),
  adapter: z.string(),   // 'filesystem' | 'git'
  method: z.string(),
  args: z.array(z.unknown()),
});
export type CapabilityCall = z.infer<typeof CapabilityCallSchema>;

export const CapabilityResultSchema = z.object({
  requestId: z.string(),
  data: z.unknown(),
});
export type CapabilityResult = z.infer<typeof CapabilityResultSchema>;

export const CapabilityErrorSchema = z.object({
  requestId: z.string(),
  code: z.string(),
  message: z.string(),
  retryable: z.boolean().default(false),
});
export type CapabilityError = z.infer<typeof CapabilityErrorSchema>;
