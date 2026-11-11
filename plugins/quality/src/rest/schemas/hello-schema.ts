import { z } from 'zod';

export const HelloRequestSchema = z.object({
  name: z.string().min(1).optional().default('World'),
});

export type HelloRequest = z.infer<typeof HelloRequestSchema>;

export const HelloResponseSchema = z.object({
  message: z.string(),
  target: z.string(),
});

export type HelloResponse = z.infer<typeof HelloResponseSchema>;
