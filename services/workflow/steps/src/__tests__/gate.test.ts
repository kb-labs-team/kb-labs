/**
 * Unit tests for gate.ts type contracts.
 *
 * Gate steps act as automatic routers — they read a decision value from
 * previous step outputs and route the pipeline to continue, fail, or restart
 * from an earlier step.
 */
import { describe, it, expect, expectTypeOf } from 'vitest'
import type { ExpressionContext } from '@kb-labs/workflow-contracts'
import { GateHandler, type GateInput, type GateOutput, type GateRouteAction } from '../gate'

// Minimal context where steps.q.outputs.ok resolves to false → routes to the
// restart action below.
const ctxFalse = {
  env: {},
  trigger: { type: 'manual' },
  steps: { q: { outputs: { ok: false } } },
} as unknown as ExpressionContext

const restartInput: GateInput = {
  decision: 'steps.q.outputs.ok',
  routes: { false: { restartFrom: 'agent-execute' } },
  maxIterations: 2,
}

describe('GateHandler restart-target guard', () => {
  it('FAILS when restartFrom matches neither a step nor a job the worker can reset', () => {
    // The worker passes same-job step ids + run job names. A target in neither
    // (e.g. a typo) cannot be restarted — fail instead of silently passing.
    const decision = new GateHandler().handle(restartInput, ctxFalse, 0, ['build', 'test', 'gate'])
    expect(decision.action).toBe('fail')
    if (decision.action === 'fail') {
      expect(decision.error.message).toContain('agent-execute')
    }
  })

  it('RESTARTS when restartFrom matches a valid target (step in this job OR a job by name)', () => {
    // Cross-job restart: agent-execute is another job the worker can reset.
    const decision = new GateHandler().handle(restartInput, ctxFalse, 0, ['agent-execute', 'build'])
    expect(decision.action).toBe('restart')
  })

  it('skips the guard when no targets are supplied (backward compatible)', () => {
    const decision = new GateHandler().handle(restartInput, ctxFalse, 0)
    expect(decision.action).toBe('restart')
  })
})

describe('GateInput type shape', () => {
  it('accepts a minimal GateInput with required fields only', () => {
    const input: GateInput = {
      decision: 'steps.review.outputs.verdict',
      routes: {
        approve: 'continue',
        reject: 'fail',
      },
    }
    expect(input.decision).toBe('steps.review.outputs.verdict')
    expect(input.routes.approve).toBe('continue')
    expect(input.routes.reject).toBe('fail')
    expect(input.default).toBeUndefined()
    expect(input.maxIterations).toBeUndefined()
  })

  it('accepts a fully specified GateInput', () => {
    const input: GateInput = {
      decision: 'steps.qa.outputs.status',
      routes: {
        pass: 'continue',
        fail: 'fail',
        retry: { restartFrom: 'build', context: { reason: 'flaky test' } },
      },
      default: 'fail',
      maxIterations: 5,
    }
    expect(input.maxIterations).toBe(5)
    expect(input.default).toBe('fail')
  })

  it('accepts a restartFrom route action with optional context', () => {
    const withContext: GateRouteAction = {
      restartFrom: 'lint',
      context: { extra: 'data' },
    }
    const withoutContext: GateRouteAction = { restartFrom: 'test' }

    expect(typeof withContext).toBe('object')
    expect(typeof withoutContext).toBe('object')
    if (typeof withContext === 'object') {
      expect((withContext as { restartFrom: string }).restartFrom).toBe('lint')
    }
  })

  it('has correct field types', () => {
    expectTypeOf<GateInput['decision']>().toBeString()
    expectTypeOf<GateInput['routes']>().toEqualTypeOf<Record<string, GateRouteAction>>()
    expectTypeOf<GateInput['default']>().toEqualTypeOf<'continue' | 'fail' | undefined>()
    expectTypeOf<GateInput['maxIterations']>().toEqualTypeOf<number | undefined>()
  })
})

describe('GateOutput type shape', () => {
  it('represents a continue outcome', () => {
    const output: GateOutput = {
      decisionValue: 'approve',
      action: 'continue',
      iteration: 1,
    }
    expect(output.action).toBe('continue')
    expect(output.iteration).toBe(1)
    expect(output.restartFrom).toBeUndefined()
  })

  it('represents a fail outcome', () => {
    const output: GateOutput = {
      decisionValue: 'reject',
      action: 'fail',
      iteration: 1,
    }
    expect(output.action).toBe('fail')
  })

  it('represents a restart outcome with restartFrom', () => {
    const output: GateOutput = {
      decisionValue: 'retry',
      action: 'restart',
      restartFrom: 'build',
      iteration: 2,
    }
    expect(output.action).toBe('restart')
    expect(output.restartFrom).toBe('build')
    expect(output.iteration).toBe(2)
  })

  it('accepts any value type for decisionValue', () => {
    const withString: GateOutput = {
      decisionValue: 'pass',
      action: 'continue',
      iteration: 1,
    }
    const withBoolean: GateOutput = {
      decisionValue: true,
      action: 'continue',
      iteration: 1,
    }
    const withNumber: GateOutput = {
      decisionValue: 0,
      action: 'fail',
      iteration: 1,
    }
    const withNull: GateOutput = {
      decisionValue: null,
      action: 'fail',
      iteration: 1,
    }

    expect(withString.decisionValue).toBe('pass')
    expect(withBoolean.decisionValue).toBe(true)
    expect(withNumber.decisionValue).toBe(0)
    expect(withNull.decisionValue).toBeNull()
  })

  it('has correct field types', () => {
    expectTypeOf<GateOutput['action']>().toEqualTypeOf<'continue' | 'fail' | 'restart' | 'skip'>()
    expectTypeOf<GateOutput['iteration']>().toBeNumber()
    expectTypeOf<GateOutput['restartFrom']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<GateOutput['skipTo']>().toEqualTypeOf<string | undefined>()
  })

  it('represents a skip outcome with skipTo', () => {
    const output: GateOutput = {
      decisionValue: 'true',
      action: 'skip',
      skipTo: 'close_issue',
      iteration: 0,
    }
    expect(output.action).toBe('skip')
    expect(output.skipTo).toBe('close_issue')
  })
})

describe('GateHandler skipTo', () => {
  const ctxTrue = {
    env: {},
    trigger: { type: 'manual' },
    steps: { prepare: { outputs: { alreadyDone: 'true' } } },
  } as unknown as ExpressionContext

  const skipInput: GateInput = {
    decision: 'steps.prepare.outputs.alreadyDone',
    routes: {
      'true': { skipTo: 'close_issue' },
    },
    default: 'continue',
  }

  it('returns skip action when decision matches a skipTo route', () => {
    const decision = new GateHandler().handle(skipInput, ctxTrue, 0, ['close_issue', 'fetch_issue'])
    expect(decision.action).toBe('skip')
    if (decision.action === 'skip') {
      expect(decision.skipTo).toBe('close_issue')
    }
  })

  it('returns continue when decision does not match skipTo route (default: continue)', () => {
    const ctxFalse2 = {
      env: {},
      trigger: { type: 'manual' },
      steps: { prepare: { outputs: { alreadyDone: 'false' } } },
    } as unknown as ExpressionContext
    const decision = new GateHandler().handle(skipInput, ctxFalse2, 0, ['close_issue'])
    expect(decision.action).toBe('continue')
  })

  it('FAILS when skipTo target is not in validRestartTargets', () => {
    const decision = new GateHandler().handle(skipInput, ctxTrue, 0, ['other_step'])
    expect(decision.action).toBe('fail')
    if (decision.action === 'fail') {
      expect(decision.error.message).toContain('close_issue')
    }
  })

  it('allows skipTo when no validRestartTargets supplied (backward compatible)', () => {
    const decision = new GateHandler().handle(skipInput, ctxTrue, 0)
    expect(decision.action).toBe('skip')
  })
})

describe('GateRouteAction type variants', () => {
  it('accepts string literal "continue"', () => {
    const action: GateRouteAction = 'continue'
    expect(action).toBe('continue')
  })

  it('accepts string literal "fail"', () => {
    const action: GateRouteAction = 'fail'
    expect(action).toBe('fail')
  })

  it('accepts an object with restartFrom', () => {
    const action: GateRouteAction = { restartFrom: 'step-a' }
    expect(typeof action).toBe('object')
  })

  it('accepts an object with restartFrom and context', () => {
    const action: GateRouteAction = {
      restartFrom: 'step-b',
      context: { injected: true },
    }
    if (typeof action === 'object') {
      expect((action as { restartFrom: string; context?: Record<string, unknown> }).context?.injected).toBe(true)
    }
  })

  it('accepts an object with skipTo', () => {
    const action: GateRouteAction = { skipTo: 'close_issue' }
    expect(typeof action).toBe('object')
    if (typeof action === 'object' && 'skipTo' in action) {
      expect((action as { skipTo: string }).skipTo).toBe('close_issue')
    }
  })
})
