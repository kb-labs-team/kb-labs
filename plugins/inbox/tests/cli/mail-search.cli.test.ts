import { expect, it } from 'vitest';
import { createMockContext, mockCLIInput } from '@kb-labs/sdk/testing';
import './test-utils.js';
import searchCommand from '../../src/commands/mail-search.js';

it('returns search results as JSON', async () => {
  type Input = Parameters<typeof searchCommand.execute>[1];
  const input = mockCLIInput<Input['flags']>({ argv: [], flags: { json: true, text: 'invoice' } });
  await expect(searchCommand.execute(createMockContext(), input)).resolves.toEqual([]);
});
