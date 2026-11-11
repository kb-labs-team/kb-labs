/**
 * Client-side turn projection reducer.
 *
 * The server owns the projection and emits its deltas (see
 * @kb-labs/agents/contracts TurnDelta) — this module is a dumb, pure
 * applier of those patches, gated by the session's monotonic `seq`. No
 * merge heuristics, no "which source is fresher" logic: a delta whose
 * `seq` isn't strictly greater than what's already applied is a duplicate
 * (safe to ignore, e.g. on WS reconnect replay); anything else is applied
 * and `lastSeq` advances to it.
 */

import type { Turn, TurnDelta } from '../contracts/index.js';

export interface TurnReducerState {
  turnsById: Map<string, Turn>;
  lastSeq: number;
}

export function createInitialState(): TurnReducerState {
  return { turnsById: new Map(), lastSeq: 0 };
}

/** Seed state from a full projection (cold-start snapshot or gap-recovery resume). */
export function loadProjection(turns: Turn[], seq: number): TurnReducerState {
  const turnsById = new Map<string, Turn>();
  for (const t of turns) { turnsById.set(t.id, t); }
  return { turnsById, lastSeq: seq };
}

/** Insert/replace a turn directly, bypassing delta application — used for
 * turns known out-of-band (the REST response's userTurn, or run:completed's
 * embedded final turn) rather than incrementally patched. */
export function setTurn(state: TurnReducerState, turn: Turn): TurnReducerState {
  const turnsById = new Map(state.turnsById);
  turnsById.set(turn.id, turn);
  return { ...state, turnsById };
}

/** Advance the seq cursor without touching turns — used when a message
 * (like run:completed) carries a seq but no incremental turn patch. */
export function advanceSeq(state: TurnReducerState, seq: number): TurnReducerState {
  return seq > state.lastSeq ? { ...state, lastSeq: seq } : state;
}

export type ApplyDeltaResult =
  | { status: 'applied'; state: TurnReducerState }
  | { status: 'duplicate'; state: TurnReducerState }
  /** Applied, but seq skipped ahead of lastSeq+1 — caller may want to resync via a full projection reload. */
  | { status: 'gap'; state: TurnReducerState };

export function applyDelta(state: TurnReducerState, delta: TurnDelta): ApplyDeltaResult {
  if (delta.seq <= state.lastSeq) {
    return { status: 'duplicate', state };
  }

  const gap = delta.seq > state.lastSeq + 1;
  const turnsById = new Map(state.turnsById);

  switch (delta.kind) {
    case 'turn:created': {
      turnsById.set(delta.turn.id, delta.turn);
      break;
    }
    case 'turn:step:appended': {
      const turn = turnsById.get(delta.turnId);
      if (turn) {
        turnsById.set(delta.turnId, { ...turn, steps: [...turn.steps, delta.step] });
      }
      break;
    }
    case 'turn:step:updated': {
      const turn = turnsById.get(delta.turnId);
      if (turn) {
        const steps = turn.steps.map((s) => (s.id === delta.step.id ? delta.step : s));
        turnsById.set(delta.turnId, { ...turn, steps });
      }
      break;
    }
    case 'turn:status': {
      const turn = turnsById.get(delta.turnId);
      if (turn) {
        turnsById.set(delta.turnId, {
          ...turn, status: delta.status, completedAt: delta.completedAt, error: delta.error,
        });
      }
      break;
    }
    case 'turn:metadata': {
      const turn = turnsById.get(delta.turnId);
      if (turn) {
        turnsById.set(delta.turnId, { ...turn, metadata: { ...turn.metadata, ...delta.patch } });
      }
      break;
    }
  }

  const nextState = { turnsById, lastSeq: delta.seq };
  return { status: gap ? 'gap' : 'applied', state: nextState };
}

/**
 * Drop optimistic (client-only) turns whose clientId now has a real
 * counterpart among `realTurns` — used to reconcile against a fresh
 * conversation:snapshot (e.g. after a reconnect or in a second tab).
 */
export function reconcileOptimistic(
  optimistic: Map<string, Turn>,
  realTurns: Turn[],
): Map<string, Turn> {
  if (optimistic.size === 0) { return optimistic; }
  const knownClientIds = new Set(
    realTurns
      .filter((t) => t.type === 'user' && t.metadata.clientId)
      .map((t) => t.metadata.clientId as string),
  );
  if (![...optimistic.keys()].some((clientId) => knownClientIds.has(clientId))) {
    return optimistic;
  }
  const next = new Map(optimistic);
  for (const clientId of knownClientIds) { next.delete(clientId); }
  return next;
}
