import { createHash } from 'node:crypto';
import type { IStorage } from '@kb-labs/sdk';

export interface StoredAgentAttachment {
  attachmentId: string;
  bytes: Buffer;
  mediaType: string;
}

function attachmentPath(sessionId: string, attachmentId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(attachmentId)) {
    throw new Error('Invalid attachment id');
  }
  const sessionKey = createHash('sha256').update(sessionId).digest('hex');
  return `agents/attachments/${sessionKey}/${attachmentId}`;
}

export async function persistAgentAttachments(
  storage: IStorage,
  sessionId: string,
  files: StoredAgentAttachment[],
): Promise<void> {
  const written: string[] = [];
  try {
    for (const file of files) {
      const key = attachmentPath(sessionId, file.attachmentId);
      await storage.write(key, file.bytes);
      written.push(key);
    }
  } catch (error) {
    await Promise.all(written.map((key) => storage.delete(key).catch(() => undefined)));
    throw error;
  }
}

export async function readAgentAttachment(
  storage: IStorage,
  sessionId: string,
  attachmentId: string,
): Promise<Buffer | null> {
  const stored: unknown = await storage.read(attachmentPath(sessionId, attachmentId));
  if (stored === null || Buffer.isBuffer(stored)) { return stored as Buffer | null; }
  // A few storage adapters cross JSON/worker boundaries and can return the
  // standard Node Buffer JSON shape instead of a live Buffer instance.
  if (typeof stored === 'object' && stored !== null) {
    const serialized = stored as unknown as { type?: unknown; __type?: unknown; data?: unknown };
    if ((serialized.type === 'Buffer' || serialized.__type === 'Buffer') && Array.isArray(serialized.data)) {
      return Buffer.from(serialized.data.filter((byte): byte is number => Number.isInteger(byte) && byte >= 0 && byte <= 255));
    }
    if (serialized.__type === 'Buffer' && typeof serialized.data === 'string') {
      return Buffer.from(serialized.data, 'base64');
    }
  }
  return null;
}
