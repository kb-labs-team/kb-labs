import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStepContext, projectStepEnvironment } from './context.js'

describe('createStepContext environment projection', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  // case: S-028.4
  it('keeps shell runtime basics and explicit workflow environment without inheriting the host environment', () => {
    vi.stubEnv('KB_W01_PARENT_SENTINEL', 'parent-secret-value')

    const context = createStepContext({
      runId: 'run-1',
      jobId: 'job-1',
      stepId: 'step-1',
      env: { WORKFLOW_VALUE: 'workflow' },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    })

    expect(context.env).toMatchObject({
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      WORKFLOW_VALUE: 'workflow',
    })
    expect(context.env).not.toHaveProperty('KB_W01_PARENT_SENTINEL')
  })

  it('keeps explicit step values above the runtime baseline without inheriting other host values', () => {
    expect(projectStepEnvironment(
      { PATH: '/workflow/path', DECLARED: 'value' },
      { PATH: '/host/path', HOME: '/host/home', KB_W01_PARENT_SENTINEL: 'secret' },
    )).toEqual({ PATH: '/workflow/path', HOME: '/host/home', DECLARED: 'value' })
  })
})
