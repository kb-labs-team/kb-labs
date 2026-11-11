import { expect, it } from 'vitest';
import { createMockContext, mockCLIInput } from '@kb-labs/sdk/testing';
import './test-utils.js';
import foldersCommand from '../../src/commands/mail-folders.js';

it('returns folders as JSON', async () => {
  type Input = Parameters<typeof foldersCommand.execute>[1];
  const input = mockCLIInput<Input['flags']>({ argv: [], flags: { json: true } });
  await expect(foldersCommand.execute(createMockContext(), input)).resolves.toEqual([]);
});
