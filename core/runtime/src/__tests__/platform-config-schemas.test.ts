import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseJsonc } from '@kb-labs/core-config'

import {
  AdapterValueSchema,
  KNOWN_ADAPTER_SLOTS,
  PlatformAdaptersSchema,
  resolveDeploymentTopology,
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

describe('resolveDeploymentTopology', () => {
  it.each(['local', 'cloud', 'k8s'] as const)('resolves declared topology %s', (topology) => {
    expect(resolveDeploymentTopology({ platform: { deployment: { topology } } })).toBe(topology)
  })

  it('refuses a missing topology with the catalogued producer hint', () => {
    expect(() => resolveDeploymentTopology({ platform: {} })).toThrow(
      expect.objectContaining({
        envelope: expect.objectContaining({
          code: 'KB_DEPLOYMENT_TOPOLOGY_REQUIRED',
          hint: expect.stringContaining('kb-create'),
        }),
      }),
    )
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
    expect(validatePlatformUserConfig({ platform: { execution: { mode: 'container' } } })).toEqual([])
    expect(validatePlatformUserConfig({ platform: { execution: { mode: 'bogus' } } })[0]?.path).toBe(
      'platform.execution.mode',
    )
  })

  it('rejects roadmap-only remote mode with the supported modes and exact config command', () => {
    expect(validatePlatformUserConfig({ platform: { execution: { mode: 'remote' } } })).toEqual([
      expect.objectContaining({
        path: 'platform.execution.mode',
        hint: 'Supported modes are auto, in-process, subprocess, worker-pool, container. Run `kb config set platform.execution.mode in-process --scope platform`.',
      }),
    ])
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
    expect(resolveDeploymentTopology(real)).toBe('local')
  })

  it('resolves the config produced for release images as cloud', () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'kb-image-default-config-'))
    const configPath = path.join(tmp, 'kb.config.json')
    try {
      execFileSync(process.execPath, [
        path.join(repoRoot, 'tools/release/generate-platform-image-default.mjs'),
        configPath,
      ], { cwd: repoRoot })
      const imageConfig = JSON.parse(readFileSync(configPath, 'utf8'))
      expect(resolveDeploymentTopology(imageConfig)).toBe('cloud')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
