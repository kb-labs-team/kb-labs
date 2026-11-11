import { describe, expect, it } from 'vitest'
import { summarizeWorkflowInput } from './input-log.js'

describe('summarizeWorkflowInput', () => {
  it('logs environment keys and declared secret markers without environment values', () => {
    const summary = summarizeWorkflowInput({
      command: 'echo $NODE_ENV',
      env: { NODE_ENV: 'production', ACCESS_TOKEN: 'secret-value' },
      nested: { env: { OTHER: 'ordinary-value' } },
    }, ['ACCESS_TOKEN'])

    expect(summary).toEqual({
      command: 'echo $NODE_ENV',
      env: { keys: ['NODE_ENV', 'ACCESS_TOKEN'], declaredSecretKeys: ['ACCESS_TOKEN'] },
      nested: { env: { keys: ['OTHER'], declaredSecretKeys: [] } },
    })
    expect(JSON.stringify(summary)).not.toContain('production')
    expect(JSON.stringify(summary)).not.toContain('secret-value')
  })
})
