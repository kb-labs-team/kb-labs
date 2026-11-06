/**
 * agent:diff - Show diff for specific file change
 *
 * Usage:
 *   pnpm kb agent:diff --change-id={id}
 *   pnpm kb agent:diff --change-id={id} --json
 */

import { defineCommand, useLogger } from '@kb-labs/sdk';
import type { CommandResult } from '@kb-labs/sdk';
import type { PluginCommandContextV3 } from '@kb-labs/sdk';
import { promises as fs } from 'fs';
import path from 'path';

type DiffInput = {
  changeId?: string;
  'change-id'?: string;
  json?: boolean;
};

type DiffResult = CommandResult<unknown>;

type DiffChange =
  | { type: 'add'; line: number; content: string }
  | { type: 'delete'; line: number; content: string }
  | { type: 'change'; line: number; before: string; after: string };

export default defineCommand({
  id: 'diff',
  description: 'Show diff for specific file change',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: DiffInput): Promise<DiffResult> {
      const logger = useLogger();
      const flags = (input as { flags?: DiffInput }).flags ?? input;

      const changeId = flags['change-id'] ?? flags.changeId;
      if (!changeId) {
        return { ok: false, error: { code: 'KB_RUNTIME_INPUT_INVALID', message: 'Missing required --change-id flag', hint: 'Pass a change ID with `kb agents diff --change-id <id>`.' } };
      }

      try {
        const basePath = path.join(process.cwd(), '.kb', 'agents', 'sessions');

        // Search all sessions for this change ID
        const sessions = await fs.readdir(basePath);
        let snapshot = null;
        let foundSessionId = null;

        for (const sessionId of sessions) {
          const snapshotPath = path.join(basePath, sessionId, 'snapshots', `${changeId}.json`);

          try {
            const content = await fs.readFile(snapshotPath, 'utf-8');
            snapshot = JSON.parse(content);
            foundSessionId = sessionId;
            break;
          } catch {
            // Try next session
            continue;
          }
        }

        if (!snapshot) {
          return { ok: false, error: { code: 'KB_RUNTIME_INPUT_INVALID', message: `Change not found: ${changeId}`, hint: 'Check the change ID, then rerun `kb agents diff --change-id <id>`.' } };
        }

        // Calculate diff
        const diff = calculateDiff(snapshot);

        const response = {
          success: true,
          changeId,
          sessionId: foundSessionId,
          data: {
            ...snapshot,
            diff,
          },
        };

        if (flags.json) {
          return response;
        } else {
          printDiff(ctx, snapshot, diff);
        }

        return response;
      } catch (err) {
        logger.error('agent:diff error:', err instanceof Error ? err : undefined);
        return { ok: false, error: { code: 'KB_RUNTIME_COMMAND_FAILED', message: err instanceof Error ? err.message : String(err), hint: 'Check the project files and rerun `kb agents diff --change-id <id>`.' } };
      }
    },
  },
});

type DiffSummary = { additions: number; deletions: number; changes: DiffChange[] };
type Snapshot = {
  id: string;
  filePath: string;
  operation: string;
  agentId: string;
  timestamp: number;
  before?: { content: string };
  after?: { content: string };
  metadata?: {
    startLine?: number;
    endLine?: number;
    linesAdded?: number;
    linesRemoved?: number;
    isOverwrite?: boolean;
  };
};

/**
 * Calculate line-by-line diff
 */
function calculateDiff(snapshot: Snapshot): DiffSummary {
  const beforeContent = snapshot.before?.content || '';
  const afterContent = snapshot.after?.content || '';

  const beforeLines = beforeContent.split('\n');
  const afterLines = afterContent.split('\n');

  const diff: DiffSummary = {
    additions: 0,
    deletions: 0,
    changes: [],
  };

  // Simple line-by-line comparison
  const maxLines = Math.max(beforeLines.length, afterLines.length);

  for (let i = 0; i < maxLines; i++) {
    const before = beforeLines[i];
    const after = afterLines[i];

    if (before === undefined && after !== undefined) {
      // Line added
      diff.additions++;
      diff.changes.push({
        type: 'add',
        line: i + 1,
        content: after,
      });
    } else if (before !== undefined && after === undefined) {
      // Line deleted
      diff.deletions++;
      diff.changes.push({
        type: 'delete',
        line: i + 1,
        content: before,
      });
    } else if (before !== after && before !== undefined && after !== undefined) {
      // Line changed
      diff.deletions++;
      diff.additions++;
      diff.changes.push({
        type: 'change',
        line: i + 1,
        before,
        after,
      });
    }
  }

  return diff;
}

/**
 * Print diff in human-readable format
 */
function printDiff(ctx: PluginCommandContextV3, snapshot: Snapshot, diff: DiffSummary): void {
  ctx.ui.write('\n');
  ctx.ui.write('📝 File Change Diff\n');
  ctx.ui.write('\n');

  const timestamp = new Date(snapshot.timestamp).toLocaleString();
  const operation = snapshot.operation.toUpperCase();

  ctx.ui.write(`Change ID: ${snapshot.id}\n`);
  ctx.ui.write(`File: ${snapshot.filePath}\n`);
  ctx.ui.write(`Operation: ${operation}\n`);
  ctx.ui.write(`Agent: ${snapshot.agentId}\n`);
  ctx.ui.write(`Timestamp: ${timestamp}\n`);
  ctx.ui.write('\n');

  if (snapshot.metadata) {
    if (snapshot.metadata.startLine !== undefined) {
      ctx.ui.write(
        `Patch: lines ${snapshot.metadata.startLine}-${snapshot.metadata.endLine}\n`
      );
    }
    if (snapshot.metadata.linesAdded !== undefined) {
      ctx.ui.write(
        `Changes: +${snapshot.metadata.linesAdded} -${snapshot.metadata.linesRemoved}\n`
      );
    }
    if (snapshot.metadata.isOverwrite) {
      ctx.ui.write('Overwrote existing file\n');
    }
    ctx.ui.write('\n');
  }

  ctx.ui.write(`Summary: +${diff.additions} -${diff.deletions}\n`);
  ctx.ui.write('\n');

  // Print diff
  ctx.ui.write('─'.repeat(60) + '\n');

  if (snapshot.operation === 'write' && !snapshot.before) {
    // New file - show full content
    ctx.ui.write('New file created:\n');
    ctx.ui.write('\n');
    const lines = (snapshot.after?.content ?? '').split('\n');
    for (let i = 0; i < Math.min(lines.length, 50); i++) {
      ctx.ui.write(`+ ${(i + 1).toString().padStart(4)} | ${lines[i]}\n`);
    }
    if (lines.length > 50) {
      ctx.ui.write(`... (${lines.length - 50} more lines)\n`);
    }
  } else {
    // Show diff
    for (const change of diff.changes) {
      if (change.type === 'add') {
        ctx.ui.write(`+ ${change.line.toString().padStart(4)} | ${change.content}\n`);
      } else if (change.type === 'delete') {
        ctx.ui.write(`- ${change.line.toString().padStart(4)} | ${change.content}\n`);
      } else if (change.type === 'change') {
        ctx.ui.write(`- ${change.line.toString().padStart(4)} | ${change.before}\n`);
        ctx.ui.write(`+ ${change.line.toString().padStart(4)} | ${change.after}\n`);
      }
    }
  }

  ctx.ui.write('─'.repeat(60) + '\n');
  ctx.ui.write('\n');
}
