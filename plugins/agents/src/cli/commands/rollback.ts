/**
 * agent:rollback — Rollback file changes made by agents.
 *
 * Uses the ChangeStore export from @kb-labs/agents/history.
 * All rollback logic is in ChangeTrackingMiddleware.rollbackRun() or handled here via ChangeStore.
 *
 * Usage:
 *   pnpm kb agent:rollback --run-id={id} --session-id={id}
 *   pnpm kb agent:rollback --file=src/index.ts --session-id={id}
 *   pnpm kb agent:rollback --session-id={id}
 *   pnpm kb agent:rollback --run-id={id} --session-id={id} --dry-run
 */

import { defineCommand, useLogger , type CommandResult} from '@kb-labs/sdk';
import type { PluginCommandContextV3 } from '@kb-labs/sdk';
import { ChangeStore } from '../../history/index.js';
import type { FileChange } from '../../history/index.js';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

type RollbackInput = {
  'run-id'?: string;
  runId?: string;
  'session-id'?: string;
  sessionId?: string;
  file?: string;
  'dry-run'?: boolean;
  dryRun?: boolean;
  json?: boolean;
};

export default defineCommand({
  id: 'rollback',
  description: 'Rollback file changes made by agents in a session or run',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: RollbackInput): Promise<CommandResult> {
      const logger = useLogger();
      const flags = ((input as Record<string, unknown>).flags ?? input) as Record<string, unknown>;

      const sessionId = (flags['session-id'] ?? flags['sessionId']) as string | undefined;
      const runId = (flags['run-id'] ?? flags['runId']) as string | undefined;
      const filePath = flags['file'] as string | undefined;
      const dryRun = Boolean(flags['dry-run'] ?? flags['dryRun']);
      const asJson = Boolean(flags['json']);

      if (!sessionId) {
        return output(ctx, asJson, { success: false, error: 'Missing --session-id' }, false);
      }

      const workingDir = process.cwd();
      const store = new ChangeStore(workingDir);

      try {
        let changes: FileChange[];

        if (runId && !filePath) {
          changes = await store.listRun(sessionId, runId);
        } else if (filePath) {
          changes = await store.listFile(sessionId, filePath);
          if (runId) {
            changes = changes.filter((c) => c.runId === runId);
          }
        } else {
          changes = await store.listSession(sessionId);
        }

        if (changes.length === 0) {
          return output(ctx, asJson, { success: true, rolledBack: 0, message: 'No changes to rollback' }, true);
        }

        // Process in reverse chronological order
        const ordered = [...changes].sort(
          (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
        );

        if (dryRun) {
          const preview = ordered.map((c) => ({
            filePath: c.filePath,
            operation: c.operation,
            action: !c.before ? 'delete (was new file)' : 'restore to before state',
          }));
          return output(ctx, asJson, { success: true, dryRun: true, wouldRollback: preview }, true);
        }

        let rolledBack = 0;
        const errors: string[] = [];

        for (const change of ordered) {
          const fullPath = path.join(workingDir, change.filePath);
          try {
            if (!change.before) {
              // File was created by agent — delete it
              await fsp.unlink(fullPath).catch((e: NodeJS.ErrnoException) => {
                if (e.code !== 'ENOENT') {throw e;}
              });
            } else {
              // Restore to before state
              await fsp.mkdir(path.dirname(fullPath), { recursive: true });
              await fsp.writeFile(fullPath, change.before.content, 'utf-8');
            }
            rolledBack++;
          } catch (e) {
            errors.push(`${change.filePath}: ${String(e)}`);
          }
        }

        return output(ctx, asJson, { success: errors.length === 0, rolledBack, errors }, errors.length === 0);
      } catch (e) {
        logger.error('agent:rollback error', e instanceof Error ? e : undefined);
        return output(ctx, asJson, { success: false, error: String(e) }, false);
      }
    },
  },
});

function output(ctx: PluginCommandContextV3, asJson: boolean, data: unknown, success: boolean): CommandResult<unknown> {
  if (asJson) {
    return data;
  } else {
    const d = data as Record<string, unknown>;
    if (d['success']) {
      if (d['dryRun']) {
        ctx.ui.write(`[DRY RUN] Would rollback:\n`);
        for (const p of (d['wouldRollback'] as Array<Record<string, string>>) ?? []) {
          ctx.ui.write(`  ${p['operation']?.toUpperCase()} ${p['filePath']} → ${p['action']}\n`);
        }
      } else {
        ctx.ui.write(`✅ Rolled back ${d['rolledBack']} change(s)\n`);
        for (const e of (d['errors'] as string[]) ?? []) {
          ctx.ui.write(`  ⚠️  ${e}\n`);
        }
      }
    } else {
      ctx.ui.write(`❌ ${d['error']}\n`);
    }
  }
  return success
    ? data
    : { ok: false, error: { code: 'KB_RUNTIME_COMMAND_FAILED', message: typeof data === 'object' && data !== null && 'error' in data && typeof data.error === 'string' ? data.error : 'Agent rollback failed.', hint: 'Check the session ID, then rerun `kb agent rollback --session-id <id>`.' } };
}
