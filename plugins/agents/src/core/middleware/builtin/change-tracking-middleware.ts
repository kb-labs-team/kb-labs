/**
 * ChangeTrackingMiddleware — captures file change snapshots via the SDK pipeline.
 *
 * Design:
 *   - order = 8 (after Observability=5, before Budget=10)
 *   - failPolicy = 'fail-open': tracking errors never break execution
 *   - Intercepts afterToolExec for fs_write / fs_patch / fs_delete
 *   - Tools must include before/after content in result.metadata (see filesystem.ts)
 *   - Persists FileChange snapshots via ChangeStore
 *   - Writes FileChangeSummary[] to RunContext.meta('changes', 'summaries') per run
 *   - SDKAgentRunner reads meta at end to populate TaskResult.fileChanges
 *
 * Data flow:
 *   fs_write/fs_patch/fs_delete
 *     → result.metadata.changeSnapshot: { operation, beforeContent?, afterContent, ...opMeta }
 *     → ChangeTrackingMiddleware.afterToolExec
 *     → ChangeStore.save()
 *     → meta('changes', 'summaries') += FileChangeSummary
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ChangeStore, toSummary } from '../../../history/index.js';
import type { FileChangeSummary, StorageConfig } from '../../../history/index.js';
import type { RunContext, ToolExecCtx, ToolOutput } from '../../../sdk/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Shape of metadata that filesystem tools embed in ToolOutput.metadata
// ─────────────────────────────────────────────────────────────────────────────

export interface ChangeSnapshot {
  operation: 'write' | 'patch' | 'delete';
  /** File content before the operation (undefined = new file) */
  beforeContent?: string;
  /** File content after the operation */
  afterContent: string;
  // Optional operation-specific fields
  isOverwrite?: boolean;
  startLine?: number;
  endLine?: number;
  linesAdded?: number;
  linesRemoved?: number;
  wasDeleted?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Meta keys
// ─────────────────────────────────────────────────────────────────────────────

const NS = 'changes';
const KEY_SUMMARIES = 'summaries';

// Tools whose output may contain a changeSnapshot
const TRACKED_TOOLS = new Set(['fs_write', 'fs_patch', 'fs_delete']);

// ─────────────────────────────────────────────────────────────────────────────
// ChangeTrackingMiddleware
// ─────────────────────────────────────────────────────────────────────────────

export interface ChangeTrackingConfig {
  agentId: string;
  sessionId: string | undefined;
  workingDir: string;
  storageConfig?: Partial<StorageConfig>;
}

export class ChangeTrackingMiddleware {
  readonly name = 'change-tracking';
  readonly order = 8;
  readonly config = { failPolicy: 'fail-open' as const };

  private readonly store: ChangeStore;
  private readonly agentId: string;
  private readonly sessionId: string | undefined;
  /** Current run ID — set on onStart, used to tag all changes in this run */
  private runId = '';

  constructor(cfg: ChangeTrackingConfig) {
    this.agentId = cfg.agentId;
    this.sessionId = cfg.sessionId;
    this.store = new ChangeStore(cfg.workingDir, cfg.storageConfig);
  }

  onStart(ctx: RunContext): void {
    this.runId = ctx.requestId;
  }

  async afterToolExec(ctx: ToolExecCtx, result: ToolOutput): Promise<void> {
    if (!result.success) {return;}
    if (!TRACKED_TOOLS.has(ctx.toolName)) {return;}

    const sessionId = ctx.run.sessionId ?? this.sessionId;
    if (!sessionId) {return;}

    const snap = result.metadata?.['changeSnapshot'] as ChangeSnapshot | undefined;
    if (!snap) {return;}

    // filePath comes from tool input
    const filePath = ctx.input['path'] as string | undefined;
    if (!filePath) {return;}

    const change = await this.store.save({
      sessionId,
      agentId: this.agentId,
      runId: this.runId,
      filePath,
      operation: snap.operation,
      beforeContent: snap.beforeContent,
      afterContent: snap.afterContent,
      metadata: {
        isOverwrite: snap.isOverwrite,
        startLine: snap.startLine,
        endLine: snap.endLine,
        linesAdded: snap.linesAdded,
        linesRemoved: snap.linesRemoved,
        wasDeleted: snap.wasDeleted,
      },
    });

    // Accumulate summaries in meta so runner can read them
    const existing = ctx.run.meta.get<FileChangeSummary[]>(NS, KEY_SUMMARIES) ?? [];
    ctx.run.meta.set(NS, KEY_SUMMARIES, [...existing, toSummary(change)]);
  }

  /** Rollback all changes captured in the current run — useful for undo-run */
  async rollbackRun(sessionId: string, workingDir: string): Promise<{ rolledBack: number; errors: string[] }> {
    const changes = await this.store.listRun(sessionId, this.runId);
    // Process in reverse chronological order
    const ordered = [...changes].sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );

    let rolledBack = 0;
    const errors: string[] = [];

    for (const change of ordered) {
      const fullPath = path.join(workingDir, change.filePath);
      try {
        if (change.operation === 'delete') {
          // Restore deleted file
          if (change.before) {
            await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
            await fs.promises.writeFile(fullPath, change.before.content, 'utf-8');
            rolledBack++;
          }
        } else if (change.before) {
          // Restore previous content
          await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
          await fs.promises.writeFile(fullPath, change.before.content, 'utf-8');
          rolledBack++;
        } else {
          // New file created by agent — delete it
          await fs.promises.unlink(fullPath).catch((e: NodeJS.ErrnoException) => {
            if (e.code !== 'ENOENT') {throw e;}
          });
          rolledBack++;
        }
      } catch (e) {
        errors.push(`${change.filePath}: ${String(e)}`);
      }
    }

    return { rolledBack, errors };
  }

  /** Expose store for external queries (CLI, REST handlers) */
  get changeStore(): ChangeStore {
    return this.store;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Meta accessor helpers — used by SDKAgentRunner to read results
// ─────────────────────────────────────────────────────────────────────────────

export function getFileChangeSummaries(ctx: RunContext): FileChangeSummary[] {
  return ctx.meta.get<FileChangeSummary[]>(NS, KEY_SUMMARIES) ?? [];
}
