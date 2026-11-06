/**
 * agent:history - Show file change history for agent sessions
 */

import { defineCommand, type PluginCommandContextV3 } from '@kb-labs/sdk';
import type { CommandResult } from '@kb-labs/sdk';
import { SessionManager } from '../../core/index.js';
import type { FileChangeSummary, Turn } from '../../contracts/index.js';

type HistoryInput = {
  sessionId?: string;
  'session-id'?: string;
  file?: string;
  agentId?: string;
  'agent-id'?: string;
  json?: boolean;
};

type HistoryResult = CommandResult<unknown>;

type ChangeRow = FileChangeSummary & {
  sessionId: string;
  turnId: string;
  turnSequence: number;
  agentId: string;
};

export default defineCommand({
  id: 'history',
  description: 'Show file change history for agent sessions',

  handler: {
    async execute(ctx: PluginCommandContextV3, input: HistoryInput): Promise<HistoryResult> {
      const flags = ('flags' in input && typeof (input as { flags?: unknown }).flags === 'object' && (input as { flags?: unknown }).flags !== null)
        ? (input as { flags: HistoryInput }).flags
        : input;
      const manager = new SessionManager(process.cwd());

      try {
        const sessionId = flags['session-id'] ?? flags.sessionId;
        const agentId = flags['agent-id'] ?? flags.agentId;
        if (sessionId) {
          return showSessionHistory(ctx, manager, String(sessionId), Boolean(flags.json));
        }
        if (flags.file) {
          return showFileHistory(ctx, manager, String(flags.file), Boolean(flags.json));
        }
        if (agentId) {
          return showAgentHistory(ctx, manager, String(agentId), Boolean(flags.json));
        }
        return listAllSessions(ctx, manager, Boolean(flags.json));
      } catch (error) {
        return { ok: false, error: { code: 'KB_RUNTIME_COMMAND_FAILED', message: error instanceof Error ? error.message : String(error), hint: 'Check the session ID and stored agent history, then rerun `kb agent history list`.' } };
      }
    },
  },
});

async function showSessionHistory(
  ctx: PluginCommandContextV3,
  manager: SessionManager,
  sessionId: string,
  asJson: boolean
): Promise<HistoryResult> {
  const info = await manager.getSessionInfo(sessionId);
  if (!info) {
    return { ok: false, error: { code: 'KB_RUNTIME_COMMAND_FAILED', message: `Session not found: ${sessionId}`, hint: 'Check the stored agent session data, then rerun `kb agent history list`.' } };
  }

  const turns = await manager.getTurns(sessionId);
  const changes = collectChanges(sessionId, turns);
  changes.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  const response = {
    success: true,
    sessionId,
    runCount: info.runCount,
    changes: changes.length,
    data: changes,
  };

  if (asJson) {
    return response;
  } else {
    ctx.ui.write(`Session: ${sessionId}\n`);
    ctx.ui.write(`Runs: ${info.runCount} | Changes: ${changes.length}\n\n`);
    for (const c of changes) {
      const ts = new Date(c.timestamp).toLocaleString();
      ctx.ui.write(`[${ts}] ${c.operation.toUpperCase()} ${c.filePath}\n`);
      ctx.ui.write(`  Agent: ${c.agentId} | Turn: #${c.turnSequence}\n`);
      ctx.ui.write(`  Change ID: ${c.changeId}\n\n`);
    }
  }

  return response;
}

async function showFileHistory(
  ctx: PluginCommandContextV3,
  manager: SessionManager,
  filePath: string,
  asJson: boolean
): Promise<HistoryResult> {
  const sessions = await manager.listSessions({ limit: 1000, offset: 0 });
  const allChanges: ChangeRow[] = [];

  for (const s of sessions.sessions) {
    const turns = await manager.getTurns(s.id);
    const changes = collectChanges(s.id, turns).filter((c) => c.filePath === filePath);
    allChanges.push(...changes);
  }

  allChanges.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  const response = {
    success: true,
    filePath,
    changes: allChanges.length,
    data: allChanges,
  };

  if (asJson) {
    return response;
  } else {
    ctx.ui.write(`File: ${filePath}\n`);
    ctx.ui.write(`Changes: ${allChanges.length}\n\n`);
    for (const c of allChanges) {
      const ts = new Date(c.timestamp).toLocaleString();
      ctx.ui.write(`[${ts}] ${c.operation.toUpperCase()} (${c.sessionId})\n`);
      ctx.ui.write(`  Agent: ${c.agentId} | Change ID: ${c.changeId}\n\n`);
    }
  }

  return response;
}

async function showAgentHistory(
  ctx: PluginCommandContextV3,
  manager: SessionManager,
  agentId: string,
  asJson: boolean
): Promise<HistoryResult> {
  const sessions = await manager.listSessions({ limit: 1000, offset: 0 });
  const allChanges: ChangeRow[] = [];

  for (const s of sessions.sessions) {
    const turns = await manager.getTurns(s.id);
    const changes = collectChanges(s.id, turns).filter((c) => c.agentId === agentId);
    allChanges.push(...changes);
  }

  allChanges.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  const response = {
    success: true,
    agentId,
    changes: allChanges.length,
    data: allChanges,
  };

  if (asJson) {
    return response;
  } else {
    ctx.ui.write(`Agent: ${agentId}\n`);
    ctx.ui.write(`Changes: ${allChanges.length}\n\n`);
    for (const c of allChanges) {
      const ts = new Date(c.timestamp).toLocaleString();
      ctx.ui.write(`[${ts}] ${c.operation.toUpperCase()} ${c.filePath} (${c.sessionId})\n`);
    }
    ctx.ui.write('\n');
  }

  return response;
}

async function listAllSessions(
  ctx: PluginCommandContextV3,
  manager: SessionManager,
  asJson: boolean
): Promise<HistoryResult> {
  const sessions = await manager.listSessions({ limit: 1000, offset: 0 });
  const uniqueSessions = dedupeSessionsById(sessions.sessions);
  const data = await Promise.all(
    uniqueSessions.map(async (s) => {
      const turns = await manager.getTurns(s.id);
      return {
        sessionId: s.id,
        status: s.status,
        runCount: s.runCount,
        lastActivityAt: s.lastActivityAt,
        changes: collectChanges(s.id, turns).length,
      };
    }),
  );

  const response = {
    success: true,
    sessions: data.length,
    data,
  };

  if (asJson) {
    return response;
  } else {
    ctx.ui.write(`Sessions: ${data.length}\n\n`);
    for (const s of data) {
      ctx.ui.write(`${s.sessionId}\n`);
      ctx.ui.write(`  Runs: ${s.runCount} | Changes: ${s.changes} | Status: ${s.status}\n`);
      ctx.ui.write(`  Last activity: ${new Date(s.lastActivityAt).toLocaleString()}\n\n`);
    }
  }

  return response;
}

function dedupeSessionsById<T extends { id: string; status?: string; runCount: number; lastActivityAt: string }>(sessions: T[]): T[] {
  const byId = new Map<string, T>();
  for (const session of sessions) {
    const existing = byId.get(session.id);
    if (!existing) {
      byId.set(session.id, session);
      continue;
    }

    const existingTs = Date.parse(existing.lastActivityAt);
    const incomingTs = Date.parse(session.lastActivityAt);
    if (incomingTs > existingTs || (incomingTs === existingTs && session.runCount > existing.runCount)) {
      byId.set(session.id, session);
    }
  }
  return Array.from(byId.values()).sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt));
}

function collectChanges(sessionId: string, turns: Turn[]): ChangeRow[] {
  const rows: ChangeRow[] = [];
  for (const turn of turns) {
    if (turn.type !== 'assistant') {
      continue;
    }
    const changes = turn.metadata.fileChanges ?? [];
    for (const change of changes) {
      rows.push({
        ...change,
        sessionId,
        turnId: turn.id,
        turnSequence: turn.sequence,
        agentId: turn.metadata.agentId,
      });
    }
  }
  return rows;
}
