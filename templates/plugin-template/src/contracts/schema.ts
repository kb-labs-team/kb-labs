import { z } from 'zod';

export const HelloCommandInputSchema = z.object({
  name: z.string().min(1, 'name cannot be empty').optional()
});

export type HelloCommandInput = z.infer<typeof HelloCommandInputSchema>;

export const HelloCommandOutputSchema = z.object({
  message: z.string(),
  target: z.string()
});

export type HelloCommandOutput = z.infer<typeof HelloCommandOutputSchema>;

export const HelloGreetingSchema = HelloCommandOutputSchema;

export type HelloGreeting = HelloCommandOutput;

export const TestLoaderCommandInputSchema = z.object({
  duration: z.number().int().positive().optional(),
  fail: z.boolean().optional(),
  stages: z.number().int().positive().optional()
});

export type TestLoaderCommandInput = z.infer<typeof TestLoaderCommandInputSchema>;

export const TestLoaderCommandOutputSchema = z.object({
  completed: z.boolean(),
  stagesRun: z.number().int().nonnegative()
});

export type TestLoaderCommandOutput = z.infer<typeof TestLoaderCommandOutputSchema>;

