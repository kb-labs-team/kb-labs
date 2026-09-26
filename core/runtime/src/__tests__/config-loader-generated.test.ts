import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { loadPlatformConfig } from '../config-loader.js'

/**
 * ADR-0047 layering in `loadPlatformConfig`:
 * generated (.kb/generated) < platform user config < project user config.
 */

function write(root: string, rel: string, contents: unknown): void {
  const full = path.join(root, rel)
  mkdirSync(path.dirname(full), { recursive: true })
  writeFileSync(full, typeof contents === 'string' ? contents : JSON.stringify(contents))
}

function makePlatformDir(dir: string): void {
  mkdirSync(path.join(dir, 'node_modules', '@kb-labs', 'cli-bin'), { recursive: true })
}

describe('loadPlatformConfig generated layer (ADR-0047)', () => {
  let tmpDir: string

  beforeAll(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'kb-cfg-gen-'))
  })

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function load(platformRoot: string, projectRoot: string) {
    return loadPlatformConfig({
      startDir: projectRoot,
      env: { KB_PLATFORM_ROOT: platformRoot, KB_PROJECT_ROOT: projectRoot },
      loadEnvFile: false,
    })
  }

  it('user config wins over generated, project over platform; generated fills the rest', async () => {
    const platformRoot = path.join(tmpDir, 'a-platform')
    const projectRoot = path.join(tmpDir, 'a-project')
    makePlatformDir(platformRoot)
    write(platformRoot, '.kb/generated/topology.jsonc', `{
      // written by the installer
      "platform": {
        "adapters": { "llm": "generated-llm", "cache": "generated-cache", "storage": "generated-storage" },
        "adapterOptions": { "serviceTransport": { "services": { "rest": { "url": "http://127.0.0.1:5050" } } } }
      }
    }`)
    write(platformRoot, '.kb/kb.config.json', {
      platform: { adapters: { llm: 'platform-llm', cache: 'platform-cache' } },
    })
    write(projectRoot, '.kb/kb.config.json', { platform: { adapters: { llm: 'project-llm' } } })

    const result = await load(platformRoot, projectRoot)

    expect(result.platformConfig.adapters).toEqual({
      llm: 'project-llm',
      cache: 'platform-cache',
      storage: 'generated-storage',
    })
    // A generated-only section still reaches the platform config.
    expect(result.platformConfig.adapterOptions).toEqual({
      serviceTransport: { services: { rest: { url: 'http://127.0.0.1:5050' } } },
    })
    expect(result.sources.generated).toEqual([path.join(platformRoot, '.kb/generated/topology.jsonc')])
  })

  it('generated product sections sit under the project config in effectiveConfig', async () => {
    const platformRoot = path.join(tmpDir, 'b-platform')
    const projectRoot = path.join(tmpDir, 'b-project')
    makePlatformDir(platformRoot)
    write(platformRoot, '.kb/generated/gateway.json', { gateway: { port: 4000, host: '127.0.0.1' } })
    write(projectRoot, '.kb/kb.config.json', { gateway: { host: '0.0.0.0' } })

    const result = await load(platformRoot, projectRoot)
    expect(result.effectiveConfig).toEqual({ gateway: { port: 4000, host: '0.0.0.0' } })
    // The raw project file is reported untouched.
    expect(result.rawConfig).toEqual({ gateway: { host: '0.0.0.0' } })
  })

  it('keeps working, with no generated source reported, when .kb/generated is absent', async () => {
    const platformRoot = path.join(tmpDir, 'c-platform')
    const projectRoot = path.join(tmpDir, 'c-project')
    makePlatformDir(platformRoot)
    write(projectRoot, '.kb/kb.config.json', { platform: { adapters: { llm: 'project-llm' } } })

    const result = await load(platformRoot, projectRoot)
    expect(result.platformConfig.adapters).toEqual({ llm: 'project-llm' })
    expect(result.sources.generated).toBeUndefined()
  })

  it('a malformed generated file is skipped instead of breaking the load', async () => {
    const platformRoot = path.join(tmpDir, 'd-platform')
    const projectRoot = path.join(tmpDir, 'd-project')
    makePlatformDir(platformRoot)
    write(platformRoot, '.kb/generated/broken.json', '{ nope')
    write(projectRoot, '.kb/kb.config.json', { platform: { adapters: { llm: 'project-llm' } } })

    const result = await load(platformRoot, projectRoot)
    expect(result.platformConfig.adapters).toEqual({ llm: 'project-llm' })
    expect(result.sources.generated).toBeUndefined()
  })
})
