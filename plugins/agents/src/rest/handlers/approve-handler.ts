/**
 * POST /sessions/:sessionId/approve
 * Mark file changes as explicitly approved by the user.
 */

import { defineHandler, rethrowForRest, type RestInput, type PluginContextV3 } from '@kb-labs/sdk';
import { SessionManager } from '../../core/index.js';
import { SnapshotStorage } from '../../history/index.js';
import { agentSessionNotFound } from './session-errors.js';

interface ApproveRequest {
  runId?: string;
  changeIds?: string[];
}

interface ApproveResponse {
  approved: number;
  changeIds: string[];
  approvedAt: string;
}

export default defineHandler({
  async execute(
    ctx: PluginContextV3,
    input: RestInput<ApproveRequest>
  ): Promise<ApproveResponse> {
    try {
      const params = input.params as Record<string, string> | undefined;
      const sessionId = params?.sessionId;

      if (!sessionId) {throw new Error('Session ID is required');}

      const body = (input.body ?? {}) as ApproveRequest;

      const sessionManager = new SessionManager(ctx.cwd);
      const session = await sessionManager.loadSession(sessionId);
      if (!session) {
        throw agentSessionNotFound(sessionId);
      }

      // Use session's own workingDir for snapshot lookup (may differ from ctx.cwd)
      const workingDir = session.workingDir || ctx.cwd;
      const storage = new SnapshotStorage(workingDir);
      let changes = await storage.listSnapshots(sessionId);

      if (body.runId) {
        changes = changes.filter((c) => c.runId === body.runId);
      } else if (body.changeIds?.length) {
        const ids = new Set(body.changeIds);
        changes = changes.filter((c) => ids.has(c.id));
      }

      const approvedAt = new Date().toISOString();
      const approvedIds: string[] = [];

      for (const change of changes) {
        change.approved = true;
        change.approvedAt = approvedAt;
        await storage.saveSnapshot(sessionId, change);
        approvedIds.push(change.id);
      }

      // Patch turns.json so the UI reflects approved state after page reload
      if (body.runId && approvedIds.length > 0) {
        const updatedSummaries = changes.map((c) => ({
          changeId: c.id,
          filePath: c.filePath,
          operation: c.operation,
          timestamp: c.timestamp,
          linesAdded: c.metadata?.linesAdded,
          linesRemoved: c.metadata?.linesRemoved,
          isNew: !c.before,
          sizeAfter: c.after.size,
          approved: true,
          approvedAt,
        }));
        await sessionManager.updateTurnFileChanges(sessionId, body.runId, updatedSummaries);
      }

      ctx.platform.logger.info(
        `[approve-handler] Session ${sessionId}: approved ${approvedIds.length} changes`
      );

      return { approved: approvedIds.length, changeIds: approvedIds, approvedAt };
    } catch (err) {
      rethrowForRest(err);
    }
  },
});
