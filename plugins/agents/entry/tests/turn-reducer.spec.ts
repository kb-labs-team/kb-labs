import { describe, expect, it } from 'vitest';
import type { Turn, TurnDelta } from '@kb-labs/agent-contracts';
import {
  createInitialState,
  loadProjection,
  setTurn,
  advanceSeq,
  applyDelta,
  reconcileOptimistic,
} from '../src/studio/turn-reducer';

function assistantTurn(overrides: Partial<Turn> = {}): Turn {
  return {
    id: 'turn-agent-1',
    type: 'assistant',
    sequence: 2,
    startedAt: 't0',
    completedAt: null,
    status: 'streaming',
    steps: [],
    metadata: { agentId: 'agent-1' },
    ...overrides,
  };
}

describe('turn-reducer — applyDelta', () => {
  it('applies turn:created and advances lastSeq', () => {
    const state = createInitialState();
    const delta: TurnDelta = { kind: 'turn:created', seq: 1, turn: assistantTurn() };

    const result = applyDelta(state, delta);

    expect(result.status).toBe('applied');
    expect(result.state.lastSeq).toBe(1);
    expect(result.state.turnsById.get('turn-agent-1')).toEqual(assistantTurn());
  });

  it('ignores a delta whose seq is <= lastSeq (idempotent replay, e.g. on reconnect)', () => {
    const seeded = loadProjection([assistantTurn()], 5);
    const stale: TurnDelta = {
      kind: 'turn:step:appended', seq: 3, turnId: 'turn-agent-1',
      step: { type: 'text', id: 'step-1', timestamp: 't1', content: 'hi' },
    };

    const result = applyDelta(seeded, stale);

    expect(result.status).toBe('duplicate');
    expect(result.state).toBe(seeded); // unchanged, same reference
  });

  it('flags a gap when seq skips ahead of lastSeq + 1, but still applies it', () => {
    const state = createInitialState();
    const delta: TurnDelta = { kind: 'turn:created', seq: 5, turn: assistantTurn() };

    const result = applyDelta(state, delta);

    expect(result.status).toBe('gap');
    expect(result.state.lastSeq).toBe(5);
    expect(result.state.turnsById.has('turn-agent-1')).toBe(true);
  });

  it('turn:step:appended adds a new step without touching existing ones', () => {
    let state = createInitialState();
    state = applyDelta(state, { kind: 'turn:created', seq: 1, turn: assistantTurn() }).state;
    state = applyDelta(state, {
      kind: 'turn:step:appended', seq: 2, turnId: 'turn-agent-1',
      step: { type: 'text', id: 'step-1', timestamp: 't1', content: 'hello' },
    }).state;

    expect(state.turnsById.get('turn-agent-1')?.steps).toHaveLength(1);
    expect(state.turnsById.get('turn-agent-1')?.steps[0]).toMatchObject({ id: 'step-1', content: 'hello' });
  });

  it('turn:step:updated replaces the step with matching id, leaves other steps alone', () => {
    let state = loadProjection([assistantTurn({
      steps: [
        { type: 'text', id: 'step-1', timestamp: 't1', content: 'first' },
        {
          type: 'tool_use', id: 'step-2', timestamp: 't2', toolName: 'fs:read',
          input: {}, status: 'pending',
        },
      ],
    })], 1);

    state = applyDelta(state, {
      kind: 'turn:step:updated', seq: 2, turnId: 'turn-agent-1',
      step: {
        type: 'tool_use', id: 'step-2', timestamp: 't2', toolName: 'fs:read',
        input: {}, status: 'done', success: true, output: 'contents',
      },
    }).state;

    const steps = state.turnsById.get('turn-agent-1')!.steps;
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({ id: 'step-1', content: 'first' }); // untouched
    expect(steps[1]).toMatchObject({ id: 'step-2', status: 'done', output: 'contents' });
  });

  it('turn:status updates status/completedAt/error without touching steps', () => {
    let state = loadProjection([assistantTurn()], 1);
    state = applyDelta(state, {
      kind: 'turn:status', seq: 2, turnId: 'turn-agent-1',
      status: 'completed', completedAt: 't9',
    }).state;

    const turn = state.turnsById.get('turn-agent-1')!;
    expect(turn.status).toBe('completed');
    expect(turn.completedAt).toBe('t9');
  });

  it('turn:metadata merges the patch into existing metadata, not a full replace', () => {
    let state = loadProjection([assistantTurn({ metadata: { agentId: 'agent-1', totalTokens: 10 } })], 1);
    state = applyDelta(state, {
      kind: 'turn:metadata', seq: 2, turnId: 'turn-agent-1', patch: { runId: 'run-1' },
    }).state;

    expect(state.turnsById.get('turn-agent-1')?.metadata).toEqual({
      agentId: 'agent-1', totalTokens: 10, runId: 'run-1',
    });
  });

  it('a delta for an unknown turnId is a silent no-op on turns (but still advances lastSeq via gap/applied)', () => {
    const state = createInitialState();
    const result = applyDelta(state, {
      kind: 'turn:step:appended', seq: 1, turnId: 'turn-does-not-exist',
      step: { type: 'text', id: 'step-1', timestamp: 't1', content: 'x' },
    });

    expect(result.state.turnsById.size).toBe(0);
    expect(result.state.lastSeq).toBe(1);
  });
});

describe('turn-reducer — setTurn / advanceSeq', () => {
  it('setTurn inserts/replaces a turn directly without requiring a seq', () => {
    const state = createInitialState();
    const next = setTurn(state, assistantTurn({ status: 'completed' }));

    expect(next.turnsById.get('turn-agent-1')?.status).toBe('completed');
    expect(next.lastSeq).toBe(0); // unaffected — direct inserts don't move the cursor
  });

  it('advanceSeq only moves the cursor forward, never backward', () => {
    const state = { turnsById: new Map(), lastSeq: 10 };
    expect(advanceSeq(state, 15).lastSeq).toBe(15);
    expect(advanceSeq(state, 3)).toBe(state); // no-op, same reference
  });

  it('cursor-only session events keep the next turn delta contiguous', () => {
    const initial = createInitialState();
    const afterCursor = advanceSeq(initial, 4);
    const result = applyDelta(afterCursor, {
      kind: 'turn:created', seq: 5, turn: assistantTurn(),
    });

    expect(result.status).toBe('applied');
    expect(result.state.lastSeq).toBe(5);
  });
});

describe('turn-reducer — reconcileOptimistic', () => {
  it('drops an optimistic turn once a real turn with the same clientId appears', () => {
    const optimistic = new Map([
      ['client-abc', { id: 'optimistic-client-abc', type: 'user', metadata: { agentId: 'user', clientId: 'client-abc' } } as Turn],
    ]);
    const realTurns: Turn[] = [
      {
        id: 'turn-run-1-user', type: 'user', sequence: 1, startedAt: 't0', completedAt: 't0',
        status: 'completed', steps: [], metadata: { agentId: 'user', clientId: 'client-abc' },
      },
    ];

    const result = reconcileOptimistic(optimistic, realTurns);

    expect(result.has('client-abc')).toBe(false);
  });

  it('leaves unrelated optimistic turns alone', () => {
    const optimistic = new Map([
      ['client-abc', { id: 'optimistic-client-abc' } as Turn],
    ]);

    const result = reconcileOptimistic(optimistic, []);

    expect(result).toBe(optimistic); // same reference — no-op fast path
  });
});
