/**
 * POST /sessions/:sessionId/rollback — Rollback file changes.
 * Body: { runId?: string; changeIds?: string[]; skipConflicts?: boolean }
 */

import { defineHandler, rethrowForRest, type RestInput, type PluginContextV3 } from '@kb-labs/sdk';
import { SessionManager } from '../../core/index.js';
import { ChangeStore } from '../../history/index.js';
import type { FileChange } from '../../history/index.js';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { agentSessionNotFound } from './session-errors.js';

interface RollbackRequest {
  runId?: string;
  changeIds?: string[];
  skipConflicts?: boolean;
}

interface ConflictEntry {
  filePath: string;
  changeId: string;
  reason: string;
}

interface RollbackResponse {
  rolledBack: number;
  skipped: number;
  conflicts: ConflictEntry[];
  success: boolean;
}

export default defineHandler({
  async execute(ctx: PluginContextV3, input: RestInput<RollbackRequest>): Promise<RollbackResponse> {
    try {
      const params = input.params as Record<string, string> | undefined;
      const sessionId = params?.sessionId;
      if (!sessionId) {throw new Error('Session ID is required');}

      const body = (input.body ?? {}) as RollbackRequest;

      const sessionManager = new SessionManager(ctx.cwd);
      const session = await sessionManager.loadSession(sessionId);
      if (!session) {
        throw agentSessionNotFound(sessionId);
      }

      const workingDir = session.workingDir || ctx.cwd;
      const store = new ChangeStore(workingDir);

      let changes: FileChange[];
      if (body.runId) {
        changes = await store.listRun(sessionId, body.runId);
      } else if (body.changeIds?.length) {
        const ids = new Set(body.changeIds);
        const all = await store.listSession(sessionId);
        changes = all.filter((c) => ids.has(c.id));
      } else {
        changes = await store.listSession(sessionId);
      }

      if (changes.length === 0) {
        return { rolledBack: 0, skipped: 0, conflicts: [], success: true };
      }

      // Reverse-chronological: undo latest first
      const sorted = [...changes].sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
      );

      // For conflict detection: full session history
      const fullHistory = await store.listSession(sessionId);
      const rollbackIds = new Set(sorted.map((c) => c.id));

      const conflicts: ConflictEntry[] = [];
      let rolledBack = 0;
      let skipped = 0;

      for (const change of sorted) {
        // Conflict: newer changes to same file NOT in our rollback set
        if (!body.skipConflicts) {
          const laterChanges = fullHistory.filter(
            (c) =>
              c.filePath === change.filePath &&
              new Date(c.timestamp).getTime() > new Date(change.timestamp).getTime() &&
              !rollbackIds.has(c.id),
          );
          if (laterChanges.length > 0) {
            const laterAgents = [...new Set(laterChanges.map((c) => c.agentId))].join(', ');
            conflicts.push({
              filePath: change.filePath,
              changeId: change.id,
              reason: `File was modified after this change by: ${laterAgents}. Use skipConflicts: true to force.`,
            });
            skipped++;
            continue;
          }
        }

        const fullPath = path.join(workingDir, change.filePath);
        try {
          if (change.before) {
            await fsp.mkdir(path.dirname(fullPath), { recursive: true });
            await fsp.writeFile(fullPath, change.before.content, 'utf-8');
          } else {
            await fsp.unlink(fullPath).catch((e: NodeJS.ErrnoException) => {
              if (e.code !== 'ENOENT') {throw e;}
            });
          }
          rolledBack++;
        } catch (e) {
          conflicts.push({
            filePath: change.filePath,
            changeId: change.id,
            reason: `Write failed: ${e instanceof Error ? e.message : String(e)}`,
          });
          skipped++;
        }
      }

      ctx.platform.logger.info(
        `[rollback-handler] Session ${sessionId}: rolled back ${rolledBack}, skipped ${skipped}`,
      );

      return { rolledBack, skipped, conflicts, success: skipped === 0 };
    } catch (err) {
      rethrowForRest(err);
    }
  },
});
