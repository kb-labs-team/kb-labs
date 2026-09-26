import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseJsonc } from '@kb-labs/core-config'

import {
  AdapterValueSchema,
  KNOWN_ADAPTER_SLOTS,
  PlatformAdaptersSchema,
  validatePlatformUserConfig,
} from '../config-schemas.js'

describe('AdapterValueSchema / platform.adapters', () => {
  it('accepts a package name, a list of names, and null', () => {
    expect(AdapterValueSchema.safeParse('@kb-labs/adapters-openai').success).toBe(true)
    expect(AdapterValueSchema.safeParse(['@kb-labs/adapters-openai', '@kb-labs/adapters-vibeproxy']).success).toBe(true)
    expect(AdapterValueSchema.safeParse(null).success).toBe(true)
  })

  it('rejects numbers, empty strings and empty lists', () => {
    expect(AdapterValueSchema.safeParse(3).success).toBe(false)
    expect(AdapterValueSchema.safeParse('').success).toBe(false)
    expect(AdapterValueSchema.safeParse([]).success).toBe(false)
  })

  it('allows custom slots but types their values', () => {
    expect(PlatformAdaptersSchema.safeParse({ llm: 'x', myCustomSlot: 'pkg' }).success).toBe(true)
    expect(PlatformAdaptersSchema.safeParse({ myCustomSlot: 5 }).success).toBe(false)
  })

  it('declares every slot the real config uses', () => {
    for (const slot of ['llm', 'cache', 'storage', 'documentDatabase', 'kvStore', 'serviceTransport', 'workspace', 'environment']) {
      expect(KNOWN_ADAPTER_SLOTS).toContain(slot)
    }
  })
})

describe('validatePlatformUserConfig', () => {
  it('accepts the installed-mode shorthand and product sections it does not own', () => {
    expect(validatePlatformUserConfig({ platform: '/opt/kb-platform', plugins: { commit: {} }, gateway: { port: 4000 } })).toEqual([])
  })

  it('reports the field path of a wrong adapter value', () => {
    expect(validatePlatformUserConfig({ platform: { adapters: { llm: 42 } } })).toEqual([
      expect.objectContaining({ path: expect.stringContaining('platform.adapters.llm') }),
    ])
  })

  it('reports non-object adapter options with the offending adapter in the path', () => {
    const issues = validatePlatformUserConfig({ platform: { adapterOptions: { llm: 'gpt-4o' } } })
    expect(issues[0]?.path).toBe('platform.adapterOptions.llm')
    expect(issues[0]?.message).toContain('object')
  })

  it('validates the execution section through the existing schema', () => {
    expect(validatePlatformUserConfig({ platform: { execution: { mode: 'container' } } })[0]?.path).toBe(
      'platform.execution.container',
    )
    expect(validatePlatformUserConfig({ platform: { execution: { mode: 'bogus' } } })[0]?.path).toBe(
      'platform.execution.mode',
    )
  })

  it('validates numeric core limits', () => {
    expect(validatePlatformUserConfig({ platform: { core: { jobs: { maxConcurrent: 0 } } } })[0]?.path).toBe(
      'platform.core.jobs.maxConcurrent',
    )
    expect(validatePlatformUserConfig({ platform: { core: { jobs: { maxConcurrent: 4 } } } })).toEqual([])
  })

  it('rejects wrong top-level types', () => {
    expect(validatePlatformUserConfig({ platform: 5 })).not.toEqual([])
    expect(validatePlatformUserConfig({ adapterOptions: [] })).not.toEqual([])
  })

  it('accepts the repository\'s real .kb/kb.config.jsonc (read-only check)', () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
    const real = parseJsonc(readFileSync(path.join(repoRoot, '.kb', 'kb.config.jsonc'), 'utf8'))
    expect(validatePlatformUserConfig(real)).toEqual([])
  })
})
