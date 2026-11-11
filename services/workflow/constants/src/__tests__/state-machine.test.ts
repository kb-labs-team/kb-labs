import { describe, expect, it } from 'vitest'
import {
  RUN_TRANSITIONS,
  JOB_TRANSITIONS,
  STEP_TRANSITIONS,
  isTerminal,
  isParked,
  isActive,
  assertTransition,
  IllegalStateTransitionError,
  type EntityKind,
} from '../state-machine'
import { RUN_STATES, JOB_STATES, STEP_STATES } from '../index'

const TABLES: Record<EntityKind, Record<string, readonly string[]>> = {
  run: RUN_TRANSITIONS,
  job: JOB_TRANSITIONS,
  step: STEP_TRANSITIONS,
}

const STATES: Record<EntityKind, readonly string[]> = {
  run: RUN_STATES,
  job: JOB_STATES,
  step: STEP_STATES,
}

describe('state-machine transition tables', () => {
  for (const kind of ['run', 'job', 'step'] as const) {
    it(`${kind}: every state in the enum has a table entry`, () => {
      for (const state of STATES[kind]) {
        expect(TABLES[kind]).toHaveProperty(state)
      }
    })

    it(`${kind}: every legal "to" target is itself a known state`, () => {
      for (const [, tos] of Object.entries(TABLES[kind])) {
        for (const to of tos) {
          expect(STATES[kind]).toContain(to)
        }
      }
    })
  }

  it('legal transitions do not throw', () => {
    for (const kind of ['run', 'job', 'step'] as const) {
      for (const [from, tos] of Object.entries(TABLES[kind])) {
        for (const to of tos) {
          expect(() => assertTransition(kind, from, to)).not.toThrow()
        }
      }
    }
  })

  it('illegal transitions throw IllegalStateTransitionError', () => {
    // A sampling of nonsensical/illegal transitions, including the exact
    // shape of the reported bug: a terminal job flipping back to running.
    const illegal: Array<[EntityKind, string, string]> = [
      ['job', 'failed', 'running'],
      ['job', 'success', 'running'],
      ['job', 'cancelled', 'queued'],
      ['run', 'failed', 'running'],
      ['run', 'success', 'failed'],
      ['step', 'failed', 'success'],
      ['step', 'success', 'failed'],
    ]
    for (const [kind, from, to] of illegal) {
      expect(() => assertTransition(kind, from, to)).toThrow(IllegalStateTransitionError)
    }
  })

  it('same-state transitions are always a no-op (idempotent re-write)', () => {
    for (const kind of ['run', 'job', 'step'] as const) {
      for (const state of STATES[kind]) {
        expect(() => assertTransition(kind, state, state)).not.toThrow()
      }
    }
  })

  it('allowReset bypasses the table for bulk-reset callers', () => {
    expect(() => assertTransition('job', 'success', 'queued')).toThrow(IllegalStateTransitionError)
    expect(() => assertTransition('job', 'success', 'queued', { allowReset: true })).not.toThrow()
  })

  it('cancellation stays legal from parked job states (required for cancelRun)', () => {
    expect(() => assertTransition('job', 'waiting_approval', 'cancelled')).not.toThrow()
    expect(() => assertTransition('job', 'waiting_child', 'cancelled')).not.toThrow()
    expect(() => assertTransition('job', 'interrupted', 'cancelled')).not.toThrow()
  })
})

describe('isTerminal / isParked / isActive predicates', () => {
  it('job: waiting_approval and waiting_child are parked, not terminal, not active', () => {
    expect(isParked('waiting_approval', 'job')).toBe(true)
    expect(isParked('waiting_child', 'job')).toBe(true)
    expect(isTerminal('waiting_approval', 'job')).toBe(false)
    expect(isTerminal('waiting_child', 'job')).toBe(false)
    expect(isActive('waiting_approval', 'job')).toBe(false)
    expect(isActive('waiting_child', 'job')).toBe(false)
  })

  it('job: interrupted is parked, not terminal (resumable — §0E)', () => {
    expect(isParked('interrupted', 'job')).toBe(true)
    expect(isTerminal('interrupted', 'job')).toBe(false)
  })

  it('job: running/queued are active, not parked, not terminal', () => {
    for (const state of ['running', 'queued']) {
      expect(isActive(state, 'job')).toBe(true)
      expect(isParked(state, 'job')).toBe(false)
      expect(isTerminal(state, 'job')).toBe(false)
    }
  })

  it('job: success/failed/cancelled/skipped are terminal, not active, not parked', () => {
    for (const state of ['success', 'failed', 'cancelled', 'skipped']) {
      expect(isTerminal(state, 'job')).toBe(true)
      expect(isActive(state, 'job')).toBe(false)
      expect(isParked(state, 'job')).toBe(false)
    }
  })

  it('every job state is classified as exactly one of terminal/parked/active', () => {
    for (const state of JOB_STATES) {
      const classes = [isTerminal(state, 'job'), isParked(state, 'job'), isActive(state, 'job')]
      expect(classes.filter(Boolean).length).toBe(1)
    }
  })

  it('every run state is classified as exactly one of terminal/active (runs have no parked state)', () => {
    for (const state of RUN_STATES) {
      expect(isParked(state, 'run')).toBe(false)
      const classes = [isTerminal(state, 'run'), isActive(state, 'run')]
      expect(classes.filter(Boolean).length).toBe(1)
    }
  })

  it('every step state is classified as exactly one of terminal/parked/active', () => {
    for (const state of STEP_STATES) {
      const classes = [isTerminal(state, 'step'), isParked(state, 'step'), isActive(state, 'step')]
      expect(classes.filter(Boolean).length).toBe(1)
    }
  })
})

describe('IllegalStateTransitionError', () => {
  it('carries kind/from/to for callers to inspect', () => {
    try {
      assertTransition('job', 'failed', 'running')
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(IllegalStateTransitionError)
      const err = error as IllegalStateTransitionError
      expect(err.kind).toBe('job')
      expect(err.from).toBe('failed')
      expect(err.to).toBe('running')
    }
  })
})
