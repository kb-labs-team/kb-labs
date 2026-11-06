import { describe, expect, it } from 'vitest'
import { getJobSecretNames, getStepSecretNames, getWorkflowSecretNames } from './secret-scopes'

describe('workflow declared secret scopes', () => {
  // case: S-028.5
  it('includes secrets declared only on job hook steps in the job and workflow scopes', () => {
    const job = {
      runsOn: 'sandbox' as const,
      secrets: ['job-secret'],
      steps: [{ name: 'main', secrets: ['step-secret'] }],
      hooks: {
        pre: [{ name: 'prepare', secrets: ['hook-only-secret'] }],
      },
    }

    expect(getJobSecretNames(job)).toEqual([
      'job-secret',
      'step-secret',
      'hook-only-secret',
    ])
    expect(getStepSecretNames({ secrets: ['step-secret'] })).toEqual(['step-secret'])
    expect(getWorkflowSecretNames({
      secrets: ['workflow-secret'],
      jobs: { main: job },
    })).toEqual([
      'workflow-secret',
      'job-secret',
      'step-secret',
      'hook-only-secret',
    ])
  })
})
