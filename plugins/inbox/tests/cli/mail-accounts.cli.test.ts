import { expect, it } from 'vitest';
import { createMockContext, mockCLIInput } from '@kb-labs/sdk/testing';
import './test-utils.js';
import accountsCommand from '../../src/commands/mail-accounts.js';

it('returns configured accounts as JSON', async () => {
  type Input = Parameters<typeof accountsCommand.execute>[1];
  const input = mockCLIInput<Input['flags']>({ argv: [], flags: { json: true } });
  await expect(accountsCommand.execute(createMockContext(), input)).resolves.toEqual([]);
});
