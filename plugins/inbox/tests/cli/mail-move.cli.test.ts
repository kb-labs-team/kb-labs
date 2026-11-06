import { expect, it } from 'vitest';
import { createMockContext, mockCLIInput } from '@kb-labs/sdk/testing';
import './test-utils.js';
import moveCommand from '../../src/commands/mail-move.js';

it('moves a message and returns its destination as JSON', async () => {
  type Input = Parameters<typeof moveCommand.execute>[1];
  const input = mockCLIInput<Input['flags']>({ argv: ['1'], flags: { json: true, folder: 'Archive' } });
  await expect(moveCommand.execute(createMockContext(), input)).resolves.toEqual({ uid: 1, folder: 'Archive' });
});
