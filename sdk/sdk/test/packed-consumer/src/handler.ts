import { defineCommand } from '@kb-labs/sdk/command';

export const handler = defineCommand({
  id: 'fixture:hello',
  handler: {
    execute: async () => ({ ok: true, result: { message: 'hello' } }),
  },
});
