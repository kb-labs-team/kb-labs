import { afterEach, describe, expect, it, vi } from 'vitest'
import { mockLogger } from '@kb-labs/shared-testing'
import { ErrorEnvelopeError, type DetailsFor } from '@kb-labs/core-platform'
import { EnvSecretProvider } from '../secrets.js'
import { WorkflowLoader } from '../workflow-loader.js'

describe('workflow secret validation', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  // case: S-028.5
  it('rejects a provided secret shorter than the safe redaction minimum with a catalogued error', () => {
    vi.stubEnv('CUSTOM_W01_SHORT', 'short')
    const loader = new WorkflowLoader(mockLogger(), new EnvSecretProvider({ prefix: 'CUSTOM_', allowPlain: false }))

    try {
      loader.fromInline({
      name: 'secret-validation',
      version: '1',
      on: { manual: true },
      secrets: ['W01_SHORT'],
      jobs: {
        main: {
          runsOn: 'sandbox',
          steps: [{ name: 'inspect', uses: 'builtin:shell', with: { command: 'true' } }],
        },
      },
      })
      throw new Error('expected short secret validation to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(ErrorEnvelopeError)
      expect((error as ErrorEnvelopeError).envelope).toMatchObject({
        code: 'KB_CONFIG_INVALID',
        details: { path: 'secret.W01_SHORT' },
        hint: 'Set CUSTOM_W01_SHORT to a value with at least 8 characters, then run "kb workflow lint".',
      })
    }
  })

  // case: S-028.5
  it('reports a missing secret with the provider source and secret name', () => {
    const loader = new WorkflowLoader(mockLogger(), new EnvSecretProvider({ prefix: 'CUSTOM_', allowPlain: false }))
    try {
      loader.fromInline({
        name: 'secret-validation',
        version: '1',
        on: { manual: true },
        secrets: ['W01_MISSING'],
        jobs: {
          main: {
            runsOn: 'sandbox',
            steps: [{ name: 'inspect', uses: 'builtin:shell', with: { command: 'true' } }],
          },
        },
      })
      throw new Error('expected missing secret validation to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(ErrorEnvelopeError)
      const expectedDetails: DetailsFor<'KB_CONFIG_SECRET_MISSING'> = {
        secretName: 'W01_MISSING',
        variable: 'CUSTOM_W01_MISSING',
      }
      expect((error as ErrorEnvelopeError).envelope).toMatchObject({
        code: 'KB_CONFIG_SECRET_MISSING',
        details: expectedDetails,
        hint: 'Set CUSTOM_W01_MISSING, then run "kb workflow lint".',
      })
    }
  })
})
