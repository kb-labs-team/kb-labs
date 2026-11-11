import { expect, it } from 'vitest';
import { createMockContext, mockCLIInput } from '@kb-labs/sdk/testing';
import './test-utils.js';
import threadCommand from '../../src/commands/mail-thread.js';

it('returns a thread as JSON', async () => {
  type Input = Parameters<typeof threadCommand.execute>[1];
  const input = mockCLIInput<Input['flags']>({ argv: ['1'], flags: { json: true } });
  await expect(threadCommand.execute(createMockContext(), input)).resolves.toEqual([]);
});
