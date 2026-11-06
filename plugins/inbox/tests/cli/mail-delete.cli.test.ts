import { expect, it } from 'vitest';
import { createMockContext, mockCLIInput } from '@kb-labs/sdk/testing';
import './test-utils.js';
import deleteCommand from '../../src/commands/mail-delete.js';

it('deletes a message and returns its uid as JSON', async () => {
  type Input = Parameters<typeof deleteCommand.execute>[1];
  const input = mockCLIInput<Input['flags']>({ argv: ['1'], flags: { json: true } });
  await expect(deleteCommand.execute(createMockContext(), input)).resolves.toEqual({ uid: 1, deleted: true });
});
