import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStepContext } from '../../context.js'
import { LocalRunner } from '../local-runner.js'

describe('LocalRunner environment projection', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  // case: S-028.4, S-028.5
  it('runs with projected and declared environment values while keeping a parent sentinel out of the step and logs', async () => {
    const sentinel = 'w01-parent-secret-should-not-escape'
    vi.stubEnv('KB_W01_PARENT_SENTINEL', sentinel)
    const records: unknown[] = []
    const logger = {
      debug: (_message: string, meta?: Record<string, unknown>) => records.push(meta),
      info: (_message: string, meta?: Record<string, unknown>) => records.push(meta),
      warn: (_message: string, meta?: Record<string, unknown>) => records.push(meta),
      error: (_message: string, meta?: Record<string, unknown>) => records.push(meta),
    }
    const context = createStepContext({
      runId: 'run-1',
      jobId: 'job-1',
      stepId: 'step-1',
      env: { WORKFLOW_VALUE: 'workflow', STEP_VALUE: 'step' },
      secrets: { STEP_SECRET: sentinel },
      logger,
    })

    const result = await new LocalRunner().execute({
      spec: {
        name: 'inspect-environment',
        uses: 'builtin:shell',
        with: {
          command: `node -e "process.stdout.write(JSON.stringify({path:process.env.PATH,home:process.env.HOME,workflow:process.env.WORKFLOW_VALUE,step:process.env.STEP_VALUE,parent:process.env.KB_W01_PARENT_SENTINEL,secret:process.env.STEP_SECRET}))"`,
          env: { WORKFLOW_VALUE: 'step-override' },
        },
      },
      context,
    })

    expect(result.status).toBe('success')
    if (result.status !== 'success') return
    const output = JSON.parse(result.outputs?.stdout as string) as Record<string, string | undefined>
    expect(output.path).toBe(process.env.PATH)
    expect(output.home).toBe(process.env.HOME)
    expect(output.workflow).toBe('workflow')
    expect(output.step).toBe('step')
    expect(output.parent).toBeUndefined()
    expect(output.secret).toBe(sentinel)
    expect(JSON.stringify(records)).not.toContain(sentinel)
  })
})
