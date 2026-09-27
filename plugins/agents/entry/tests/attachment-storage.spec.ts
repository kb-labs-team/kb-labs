import { describe, expect, it, vi } from 'vitest';
import type { IStorage } from '@kb-labs/sdk';
import { readAgentAttachment } from '../src/rest/attachment-storage.js';

describe('readAgentAttachment', () => {
  const sessionId = 'session-test';
  const attachmentId = '920bbbfa-3eb4-427b-81a4-2962af3695df';

  it('returns binary content from a Buffer', async () => {
    const bytes = Buffer.from([0, 1, 2, 253, 254, 255]);
    const storage = { read: vi.fn().mockResolvedValue(bytes) } as unknown as IStorage;

    await expect(readAgentAttachment(storage, sessionId, attachmentId)).resolves.toEqual(bytes);
  });

  it('normalizes the Node Buffer JSON shape returned by a JSON-backed adapter', async () => {
    const expected = Buffer.from([0, 1, 2, 253, 254, 255]);
    const storage = {
      read: vi.fn().mockResolvedValue({ type: 'Buffer', data: [...expected] }),
    } as unknown as IStorage;

    await expect(readAgentAttachment(storage, sessionId, attachmentId)).resolves.toEqual(expected);
  });
});
