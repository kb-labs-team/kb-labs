/**
 * GET /sessions/:sessionId/changes/:changeId/diff — Unified diff for a file change snapshot.
 */

import { defineHandler, rethrowForRest, type RestInput, type PluginContextV3 } from '@kb-labs/sdk';
import { SessionManager } from '../../core/index.js';
import { ChangeStore, generateUnifiedDiff, countDiffLines } from '../../history/index.js';

interface GetFileDiffResponse {
  changeId: string;
  filePath: string;
  operation: 'write' | 'patch' | 'delete';
  diff: string;
  before?: { hash: string; size: number };
  after: { hash: string; size: number };
  linesAdded: number;
  linesRemoved: number;
  isNew: boolean;
  timestamp: string;
}

export default defineHandler({
  async execute(ctx: PluginContextV3, input: RestInput): Promise<GetFileDiffResponse> {
    try {
      const params = input.params as Record<string, string> | undefined;
      const sessionId = params?.sessionId;
      const changeId = params?.changeId;
      if (!sessionId) {throw new Error('Session ID is required');}
      if (!changeId) {throw new Error('Change ID is required');}

      const sessionManager = new SessionManager(ctx.cwd);
      const session = await sessionManager.loadSession(sessionId);
      const workingDir = session?.workingDir || ctx.cwd;

      const store = new ChangeStore(workingDir);
      const change = await store.get(sessionId, changeId);
      if (!change) {throw new Error(`Change not found: ${changeId} in session ${sessionId}`);}

      const diff = generateUnifiedDiff(change.filePath, change.before?.content, change.after.content, change.operation);
      const { added, removed } = countDiffLines(diff);

      return {
        changeId: change.id,
        filePath: change.filePath,
        operation: change.operation,
        diff,
        before: change.before ? { hash: change.before.hash, size: change.before.size } : undefined,
        after: { hash: change.after.hash, size: change.after.size },
        linesAdded: added,
        linesRemoved: removed,
        isNew: !change.before,
        timestamp: change.timestamp,
      };
    } catch (err) {
      rethrowForRest(err);
    }
  },
});
