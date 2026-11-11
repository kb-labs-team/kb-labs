/**
 * Computes the minimal set of TurnDelta patches between two states of the
 * same turn (or turn creation, when `before` is null). Steps are compared
 * positionally by index: the assembler only ever appends new steps or
 * mutates an existing step object in place, so index-alignment is sufficient
 * — there is no reordering or deletion to reconcile.
 */

import type { Turn, TurnDelta } from '../../contracts/index.js';

function stepsEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function diffTurn(before: Turn | null, after: Turn, seq: number): TurnDelta[] {
  const deltas: TurnDelta[] = [];

  if (!before) {
    deltas.push({ kind: 'turn:created', seq, turn: { ...after, steps: [] } });
    for (const step of after.steps) {
      deltas.push({ kind: 'turn:step:appended', seq, turnId: after.id, step });
    }
    if (after.status !== 'streaming') {
      deltas.push({
        kind: 'turn:status', seq, turnId: after.id,
        status: after.status, completedAt: after.completedAt, error: after.error,
      });
    }
    return deltas;
  }

  for (let i = 0; i < after.steps.length; i++) {
    const afterStep = after.steps[i];
    if (!afterStep) { continue; }
    const beforeStep = before.steps[i];
    if (!beforeStep) {
      deltas.push({ kind: 'turn:step:appended', seq, turnId: after.id, step: afterStep });
    } else if (!stepsEqual(beforeStep, afterStep)) {
      deltas.push({ kind: 'turn:step:updated', seq, turnId: after.id, step: afterStep });
    }
  }

  if (before.status !== after.status || before.completedAt !== after.completedAt) {
    deltas.push({
      kind: 'turn:status', seq, turnId: after.id,
      status: after.status, completedAt: after.completedAt, error: after.error,
    });
  }

  const beforeMeta = before.metadata as Record<string, unknown>;
  const afterMeta = after.metadata as Record<string, unknown>;
  const metaPatch: Record<string, unknown> = {};
  for (const key of Object.keys(afterMeta)) {
    if (!stepsEqual(beforeMeta[key], afterMeta[key])) {
      metaPatch[key] = afterMeta[key];
    }
  }
  if (Object.keys(metaPatch).length > 0) {
    deltas.push({ kind: 'turn:metadata', seq, turnId: after.id, patch: metaPatch });
  }

  return deltas;
}
