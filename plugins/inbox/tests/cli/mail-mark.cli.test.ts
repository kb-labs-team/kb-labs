import { expect, it } from 'vitest';
import { createMockContext, mockCLIInput } from '@kb-labs/sdk/testing';
import './test-utils.js';
import markCommand from '../../src/commands/mail-mark.js';

it('marks a message and returns the selected action as JSON', async () => {
  type Input = Parameters<typeof markCommand.execute>[1];
  const input = mockCLIInput<Input['flags']>({ argv: ['1'], flags: { json: true, read: true } });
  await expect(markCommand.execute(createMockContext(), input)).resolves.toEqual({ uid: 1, action: 'read' });
});
