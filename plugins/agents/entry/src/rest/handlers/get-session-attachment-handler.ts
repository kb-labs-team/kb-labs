import { defineHandler, rethrowForRest, type PluginContextV3, type RestInput } from '@kb-labs/sdk';
import { SessionManager } from '@kb-labs/agent-core';
import { readAgentAttachment } from '../attachment-storage.js';

interface AttachmentResponse {
  mediaType: string;
  data: string;
}

export default defineHandler({
  async execute(ctx: PluginContextV3, input: RestInput<unknown>): Promise<AttachmentResponse> {
    try {
      const params = input.params as Record<string, string> | undefined;
      const sessionId = params?.sessionId;
      const attachmentId = params?.attachmentId;
      if (!sessionId || !attachmentId) { throw new Error('Session and attachment IDs are required'); }

      const sessions = new SessionManager(ctx.cwd);
      if (!await sessions.loadSession(sessionId)) { throw new Error('Session not found'); }
      const turns = await sessions.getTurns(sessionId);
      const reference = turns
        .flatMap((turn) => turn.metadata.attachments ?? [])
        .find((attachment) => attachment.attachmentId === attachmentId);
      if (!reference) { throw new Error('Attachment not found'); }

      const bytes = await readAgentAttachment(ctx.platform.storage, sessionId, attachmentId);
      if (!bytes) { throw new Error('Attachment content is unavailable'); }
      return { mediaType: reference.mediaType, data: bytes.toString('base64') };
    } catch (error) {
      rethrowForRest(error);
    }
  },
});
