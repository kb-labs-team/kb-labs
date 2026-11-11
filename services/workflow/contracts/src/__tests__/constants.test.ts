/**
 * Unit tests for workflow-constants additions.
 *
 * Verifies that `waiting_approval` was added to STEP_STATES and that the
 * derived StepState type includes it.
 */
import { describe, it, expect } from 'vitest'
import { STEP_STATES, RUN_STATES, JOB_STATES } from '@kb-labs/workflow-constants'
import type { StepState } from '@kb-labs/workflow-constants'

describe('STEP_STATES', () => {
  it('includes waiting_approval', () => {
    expect(STEP_STATES).toContain('waiting_approval')
  })

  it('includes all RUN_STATES values', () => {
    for (const state of RUN_STATES) {
      expect(STEP_STATES).toContain(state)
    }
  })

  it('does not contain waiting_approval in RUN_STATES', () => {
    // waiting_approval is step-specific; it should not appear in run-level states
    expect(RUN_STATES).not.toContain('waiting_approval')
  })

  it('contains waiting_approval and waiting_child in JOB_STATES', () => {
    // a job parks atomically with its step, so job-level states mirror the park states
    expect(JOB_STATES).toContain('waiting_approval')
    expect(JOB_STATES).toContain('waiting_child')
  })

  it('StepState type accepts waiting_approval as a value at runtime', () => {
    // TypeScript compile-time check: this assignment must not produce a type error
    const state: StepState = 'waiting_approval'
    expect(state).toBe('waiting_approval')
  })

  it('contains all expected states', () => {
    const expected = [
      'queued',
      'running',
      'success',
      'failed',
      'cancelled',
      'skipped',
      'dlq',
      'waiting_approval',
    ]
    for (const s of expected) {
      expect(STEP_STATES).toContain(s)
    }
  })
})
