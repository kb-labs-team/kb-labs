import { expect, it } from 'vitest';
import { createMockContext, mockCLIInput } from '@kb-labs/sdk/testing';
import './test-utils.js';
import replyCommand from '../../src/commands/mail-reply.js';

it('sends a reply and returns its message id as JSON', async () => {
  type Input = Parameters<typeof replyCommand.execute>[1];
  const input = mockCLIInput<Input['flags']>({ argv: ['1'], flags: { json: true, body: 'Reply' } });
  await expect(replyCommand.execute(createMockContext(), input)).resolves.toEqual({ messageId: 'replied' });
});
