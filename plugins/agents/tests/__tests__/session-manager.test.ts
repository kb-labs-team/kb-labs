import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { AgentEvent } from '@kb-labs/agents/contracts';
import { SessionManager } from '../../src/core/planning/session-manager';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeManager(): Promise<{ dir: string; manager: SessionManager }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'session-manager-'));
  tempDirs.push(dir);
  return { dir, manager: new SessionManager(dir) };
}

function agentStart(sessionId: string, runId: string, agentId: string, timestamp: string): AgentEvent {
  return {
    type: 'agent:start',
    timestamp,
    sessionId,
    runId,
    agentId,
    data: { task: 't', tier: 'medium', maxIterations: 10, toolCount: 0 },
  } as AgentEvent;
}

async function readEventLines(dir: string, sessionId: string): Promise<Array<{ sessionSeq?: number }>> {
  const eventsPath = path.join(dir, '.kb', 'agents', 'sessions', sessionId, 'events.ndjson');
  const content = await readFile(eventsPath, 'utf-8');
  return content.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

describe('SessionManager — session-scoped sequence cursor', () => {
  it('assigns a monotonic sessionSeq across MULTIPLE runs in the same session, not restarting per run', async () => {
    const { dir, manager } = await makeManager();
    const { id: sessionId } = await manager.createSession({ mode: 'execute', task: 't', agentId: 'mind-assistant' });

    await manager.addEvent(sessionId, agentStart(sessionId, 'run-1', 'agent-1', 't0'));
    await manager.addEvent(sessionId, agentStart(sessionId, 'run-1', 'agent-1', 't1'));
    // A second, later run in the SAME session must continue the counter, not restart at 1.
    await manager.addEvent(sessionId, agentStart(sessionId, 'run-2', 'agent-2', 't2'));

    const lines = await readEventLines(dir, sessionId);
    expect(lines.map((l) => l.sessionSeq)).toEqual([1, 2, 3]);
  });

  it('bootstraps the counter from the NDJSON line count, not the max embedded sessionSeq — correct even for legacy per-run files', async () => {
    const { dir, manager } = await makeManager();
    const { id: sessionId } = await manager.createSession({ mode: 'execute', task: 't', agentId: 'mind-assistant' });

    const sessionDir = path.join(dir, '.kb', 'agents', 'sessions', sessionId);
    const eventsPath = path.join(sessionDir, 'events.ndjson');

    // Simulate a legacy session written under the old PER-RUN scheme: two
    // different runs, each restarting sessionSeq at 1 — so the max embedded
    // value (2) is far smaller than the true event count (4).
    const legacyLines = [
      { ...agentStart(sessionId, 'run-1', 'agent-1', 't0'), sessionSeq: 1 },
      { ...agentStart(sessionId, 'run-1', 'agent-1', 't1'), sessionSeq: 2 },
      { ...agentStart(sessionId, 'run-2', 'agent-2', 't2'), sessionSeq: 1 },
      { ...agentStart(sessionId, 'run-2', 'agent-2', 't3'), sessionSeq: 2 },
    ];
    await writeFile(eventsPath, legacyLines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');

    // A brand-new event appended after this legacy file must get a sessionSeq that
    // continues from the LINE COUNT (4), i.e. 5 — not from the embedded max value (2),
    // which would collide with the two existing lines that already have sessionSeq: 2.
    await manager.addEvent(sessionId, agentStart(sessionId, 'run-3', 'agent-3', 't5'));

    const lines = await readEventLines(dir, sessionId);
    expect(lines).toHaveLength(5);
    expect(lines[4]?.sessionSeq).toBe(5);
  });

  it('does not hand out colliding sessionSeq values when two different SessionManager instances race to persist events for the same session concurrently', async () => {
    // Mirrors the real call pattern: run-handler.ts constructs a fresh
    // `new SessionManager(workingDir)` on every POST /run — there is no one
    // long-lived instance per session. Before the shared-state fix,
    // sessionSeqCounters was a plain instance field, so two instances
    // racing to add their first event for the same session would each
    // bootstrap their own counter from the same (empty) snapshot and could
    // both hand out sessionSeq: 1 — a real bug that manifested as the
    // client's delta reducer silently dropping one run's turn update as an
    // "already seen" duplicate.
    const { dir, manager: manager1 } = await makeManager();
    const { id: sessionId } = await manager1.createSession({ mode: 'execute', task: 't', agentId: 'mind-assistant' });

    const manager2 = new SessionManager(dir);

    await Promise.all([
      manager1.addEvent(sessionId, agentStart(sessionId, 'run-1', 'agent-1', 't0')),
      manager2.addEvent(sessionId, agentStart(sessionId, 'run-2', 'agent-2', 't1')),
    ]);

    const lines = await readEventLines(dir, sessionId);
    expect(lines).toHaveLength(2);
    const seqs = lines.map((l) => l.sessionSeq);
    expect(new Set(seqs).size).toBe(2); // no collision
    expect([...seqs].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([1, 2]);
  });

  it('does not hand out colliding Turn.sequence values when two different SessionManager instances race to create user turns for the same session concurrently', async () => {
    const { dir, manager: manager1 } = await makeManager();
    const { id: sessionId } = await manager1.createSession({ mode: 'execute', task: 't', agentId: 'mind-assistant' });

    const manager2 = new SessionManager(dir);

    const [turnA, turnB] = await Promise.all([
      manager1.createUserTurn(sessionId, 'hello', 'run-1'),
      manager2.createUserTurn(sessionId, 'hi', 'run-2'),
    ]);

    expect(turnA.sequence).not.toBe(turnB.sequence);
  });
});

function toolStart(sessionId: string, runId: string, agentId: string, toolCallId: string, timestamp: string): AgentEvent {
  return {
    type: 'tool:start',
    timestamp,
    sessionId,
    runId,
    agentId,
    toolCallId,
    data: { toolName: 'fs:read', input: { path: 'a.ts' } },
  } as AgentEvent;
}

function toolEnd(sessionId: string, runId: string, agentId: string, toolCallId: string, timestamp: string): AgentEvent {
  return {
    type: 'tool:end',
    timestamp,
    sessionId,
    runId,
    agentId,
    toolCallId,
    data: { toolName: 'fs:read', success: true, output: 'contents', durationMs: 5 },
  } as AgentEvent;
}

describe('SessionManager — processEventAndUpdateTurn deltas', () => {
  it('returns { turn, deltas: [turn:created] } for the first event of a new turn', async () => {
    const { manager } = await makeManager();
    const { id: sessionId } = await manager.createSession({ mode: 'execute', task: 't', agentId: 'mind-assistant' });

    const result = await manager.processEventAndUpdateTurn(
      sessionId,
      { ...agentStart(sessionId, 'run-1', 'agent-1', 't0'), sessionSeq: 1 },
    );

    expect(result).not.toBeNull();
    expect(result!.turn.status).toBe('streaming');
    expect(result!.deltas).toHaveLength(1);
    expect(result!.deltas[0]).toMatchObject({ kind: 'turn:created', seq: 1 });
    // turn:created must NOT carry steps — those arrive via their own deltas.
    expect((result!.deltas[0] as { turn: { steps: unknown[] } }).turn.steps).toEqual([]);
  });

  it('returns turn:step:appended for a subsequent tool:start on the same turn, not another turn:created', async () => {
    const { manager } = await makeManager();
    const { id: sessionId } = await manager.createSession({ mode: 'execute', task: 't', agentId: 'mind-assistant' });

    await manager.processEventAndUpdateTurn(sessionId, { ...agentStart(sessionId, 'run-1', 'agent-1', 't0'), sessionSeq: 1 });
    const result = await manager.processEventAndUpdateTurn(
      sessionId,
      { ...toolStart(sessionId, 'run-1', 'agent-1', 'call-1', 't1'), sessionSeq: 2 },
    );

    expect(result!.deltas).toHaveLength(1);
    expect(result!.deltas[0]).toMatchObject({ kind: 'turn:step:appended', seq: 2 });
  });

  it('returns turn:step:updated (not appended) when tool:end mutates the existing pending step in place', async () => {
    const { manager } = await makeManager();
    const { id: sessionId } = await manager.createSession({ mode: 'execute', task: 't', agentId: 'mind-assistant' });

    await manager.processEventAndUpdateTurn(sessionId, { ...agentStart(sessionId, 'run-1', 'agent-1', 't0'), sessionSeq: 1 });
    await manager.processEventAndUpdateTurn(sessionId, { ...toolStart(sessionId, 'run-1', 'agent-1', 'call-1', 't1'), sessionSeq: 2 });
    const result = await manager.processEventAndUpdateTurn(
      sessionId,
      { ...toolEnd(sessionId, 'run-1', 'agent-1', 'call-1', 't2'), sessionSeq: 3 },
    );

    expect(result!.deltas).toHaveLength(1);
    expect(result!.deltas[0]).toMatchObject({ kind: 'turn:step:updated', seq: 3 });
  });

  it('returns null for an event that maps to no turn (assembler produced nothing)', async () => {
    const { manager } = await makeManager();
    const { id: sessionId } = await manager.createSession({ mode: 'execute', task: 't', agentId: 'mind-assistant' });

    // A tool:start with no preceding agent:start has no active turn to attach to.
    const result = await manager.processEventAndUpdateTurn(
      sessionId,
      { ...toolStart(sessionId, 'run-1', 'agent-1', 'call-1', 't0'), sessionSeq: 1 },
    );

    expect(result).toBeNull();
  });
});

describe('SessionManager — getProjection', () => {
  it('reflects both user and assistant turns, paired with the current sessionSeq cursor', async () => {
    const { manager } = await makeManager();
    const { id: sessionId } = await manager.createSession({ mode: 'execute', task: 't', agentId: 'mind-assistant' });

    await manager.createUserTurn(sessionId, 'hello', 'run-1');
    await manager.addEvent(sessionId, agentStart(sessionId, 'run-1', 'agent-1', 't0'));

    const projection = await manager.getProjection(sessionId);
    expect(projection.turns.map((t) => t.type).sort()).toEqual(['assistant', 'user']);
    expect(projection.seq).toBe(1); // one event persisted via addEvent
  });

  it('agrees with getConversationSnapshot on which turns exist (same underlying getTurns call)', async () => {
    const { manager } = await makeManager();
    const { id: sessionId } = await manager.createSession({ mode: 'execute', task: 't', agentId: 'mind-assistant' });
    await manager.createUserTurn(sessionId, 'hello', 'run-1');

    const projection = await manager.getProjection(sessionId);
    const snapshot = await manager.getConversationSnapshot(sessionId);

    expect(projection.turns).toHaveLength(snapshot.completedTurns.length + snapshot.activeTurns.length);
  });
});
