import { z } from 'zod';

const validSettings = z.object({ value: z.object({ text: z.string().min(2) }).strict() }).strict();
const stalledSettings = z.object({
  value: z.object({ text: z.string().min(2), stall: z.literal(true) }).passthrough(),
}).strict().superRefine(() => {
  const started = Date.now();
  while (Date.now() - started < 6_000) {
    // The isolated settings worker should terminate this before the finite stall ends.
  }
});

export const SettingsSchema = z.union([validSettings, stalledSettings]);
