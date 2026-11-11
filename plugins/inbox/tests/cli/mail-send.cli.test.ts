import { expect, it } from 'vitest';
import { createMockContext, mockCLIInput } from '@kb-labs/sdk/testing';
import './test-utils.js';
import sendCommand from '../../src/commands/mail-send.js';

it('sends a message and returns its message id as JSON', async () => {
  type Input = Parameters<typeof sendCommand.execute>[1];
  const input = mockCLIInput<Input['flags']>({ argv: [], flags: { json: true, to: 'user@example.com', subject: 'Hello', body: 'Message' } });
  await expect(sendCommand.execute(createMockContext(), input)).resolves.toEqual({ messageId: 'sent' });
});
