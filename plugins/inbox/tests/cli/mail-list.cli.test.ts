import { expect, it } from 'vitest';
import { createMockContext, mockCLIInput } from '@kb-labs/sdk/testing';
import './test-utils.js';
import listCommand from '../../src/commands/mail-list.js';

it('returns messages as JSON', async () => {
  type Input = Parameters<typeof listCommand.execute>[1];
  const input = mockCLIInput<Input['flags']>({ argv: [], flags: { json: true } });
  await expect(listCommand.execute(createMockContext(), input)).resolves.toEqual([]);
});
