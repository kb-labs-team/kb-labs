/**
 * Unit tests for approval.ts type contracts.
 *
 * Approval steps pause the workflow pipeline and wait for a human decision.
 * The worker polls for approval; resolveApproval() on the engine resumes
 * execution with an ApprovalOutput.
 */
import { describe, it, expect, expectTypeOf } from 'vitest'
import type { ApprovalInput, ApprovalOutput } from '../approval'

describe('ApprovalInput type shape', () => {
  it('accepts a minimal ApprovalInput with only the required title', () => {
    const input: ApprovalInput = { title: 'Deploy to production?' }
    expect(input.title).toBe('Deploy to production?')
    expect(input.context).toBeUndefined()
    expect(input.instructions).toBeUndefined()
  })

  it('accepts a fully specified ApprovalInput', () => {
    const input: ApprovalInput = {
      title: 'Approve release v2.0',
      context: {
        version: '2.0.0',
        environment: 'production',
        changesCount: 42,
      },
      instructions: 'Review the changelog before approving.',
    }
    expect(input.title).toBe('Approve release v2.0')
    expect(input.context?.version).toBe('2.0.0')
    expect(input.context?.changesCount).toBe(42)
    expect(input.instructions).toBe('Review the changelog before approving.')
  })

  it('accepts arbitrary values in context', () => {
    const input: ApprovalInput = {
      title: 'Test',
      context: {
        flag: true,
        count: 0,
        nested: { deep: 'value' },
        list: [1, 2, 3],
        nothing: null,
      },
    }
    expect(input.context?.flag).toBe(true)
    expect(input.context?.count).toBe(0)
  })

  it('has correct field types', () => {
    expectTypeOf<ApprovalInput['title']>().toBeString()
    expectTypeOf<ApprovalInput['context']>().toEqualTypeOf<Record<string, unknown> | undefined>()
    expectTypeOf<ApprovalInput['instructions']>().toEqualTypeOf<string | undefined>()
  })
})

describe('ApprovalOutput type shape', () => {
  it('represents an approved outcome', () => {
    const output: ApprovalOutput = {
      approved: true,
      action: 'approve',
    }
    expect(output.approved).toBe(true)
    expect(output.action).toBe('approve')
    expect(output.comment).toBeUndefined()
  })

  it('represents a rejected outcome', () => {
    const output: ApprovalOutput = {
      approved: false,
      action: 'reject',
      comment: 'Not ready for production.',
    }
    expect(output.approved).toBe(false)
    expect(output.action).toBe('reject')
    expect(output.comment).toBe('Not ready for production.')
  })

  it('accepts extra data from the approver via index signature', () => {
    const output: ApprovalOutput = {
      approved: true,
      action: 'approve',
      approverName: 'alice',
      approvedAt: '2026-03-06T10:00:00Z',
      ticket: 42,
    }
    expect(output.approverName).toBe('alice')
    expect(output.ticket).toBe(42)
  })

  it('has correct types for required fields', () => {
    expectTypeOf<ApprovalOutput['approved']>().toBeBoolean()
    expectTypeOf<ApprovalOutput['action']>().toEqualTypeOf<'approve' | 'reject'>()
    expectTypeOf<ApprovalOutput['comment']>().toEqualTypeOf<string | undefined>()
  })
})

