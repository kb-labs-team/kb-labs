import { expect, it } from 'vitest';
import { createMockContext, mockCLIInput } from '@kb-labs/sdk/testing';
import './test-utils.js';
import getCommand from '../../src/commands/mail-get.js';

it('returns the requested message as JSON', async () => {
  type Input = Parameters<typeof getCommand.execute>[1];
  const input = mockCLIInput<Input['flags']>({ argv: ['1'], flags: { json: true } });
  await expect(getCommand.execute(createMockContext(), input)).resolves.toEqual({});
});
