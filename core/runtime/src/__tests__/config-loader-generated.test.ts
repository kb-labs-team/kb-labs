import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { createProjectRegistry } from '@kb-labs/core-project-registry'
import { PlatformConfigError } from '@kb-labs/core-platform'
import { loadPlatformConfig } from '../config-loader.js'
import { writeTestPlatformReceipt } from './platform-version-fixture.js'

let tmpDir: string

/**
 * ADR-0052 layering in `loadPlatformConfig`:
 * manifest defaults < generated platform config < platform config < project store.
 */

function write(root: string, rel: string, contents: unknown): void {
  const full = path.join(root, rel)
  mkdirSync(path.dirname(full), { recursive: true })
  writeFileSync(full, typeof contents === 'string' ? contents : JSON.stringify(contents))
}

function makePlatformDir(dir: string): void {
  writeTestPlatformReceipt(dir)
  mkdirSync(path.join(dir, 'node_modules', '@kb-labs', 'cli-bin'), { recursive: true })
}

async function projectRegistration(root: string) {
  mkdirSync(root, { recursive: true })
  const home = path.join(tmpDir, 'kb-home')
  const env = { KB_HOME: home }
  const canonicalRoot = realpathSync(root)
  const registry = createProjectRegistry({ env })
  const existing = (await registry.list()).projects.find((entry) => entry.project.path === canonicalRoot)
  const project = existing?.project ?? (await registry.add(canonicalRoot)).project
  return { env, projectId: project.id }
}

async function writeProjectSettings(root: string, contents: unknown): Promise<void> {
  const { projectId } = await projectRegistration(root)
  const home = path.join(tmpDir, 'kb-home')
  const dir = path.join(home, 'state', projectId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'config.jsonc'), JSON.stringify(contents))
}

describe('loadPlatformConfig generated layer (ADR-0047)', () => {
  beforeAll(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'kb-cfg-gen-'))
  })

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  async function load(platformRoot: string, projectRoot: string) {
    const registration = await projectRegistration(projectRoot)
    const env = { ...registration.env, KB_PLATFORM_ROOT: realpathSync(platformRoot) }
    projectRoot = realpathSync(projectRoot)
    return loadPlatformConfig({
      startDir: projectRoot,
      env,
      projectId: registration.projectId,
      loadEnvFile: false,
    })
  }

  it('rejects project store adapter overrides above generated and platform settings', async () => {
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
    await writeProjectSettings(projectRoot, { platform: { adapters: { llm: 'project-llm' } } })

    await expect(load(platformRoot, projectRoot)).rejects.toMatchObject({ name: 'AdapterProjectScopeError' })
  })

  it('generated sections and project store settings are present in effectiveConfig', async () => {
    const platformRoot = path.join(tmpDir, 'b-platform')
    const projectRoot = path.join(tmpDir, 'b-project')
    makePlatformDir(platformRoot)
    write(platformRoot, '.kb/generated/gateway.json', { gateway: { port: 4000, host: '127.0.0.1' } })
    await writeProjectSettings(projectRoot, { plugins: { sample: { enabled: true } } })

    const result = await load(platformRoot, projectRoot)
    expect(result.effectiveConfig).toEqual({ gateway: { port: 4000, host: '127.0.0.1' }, plugins: { sample: { enabled: true } } })
    expect(result.rawConfig).toBeUndefined()
  })

  it('keeps working, with no generated source reported, when .kb/generated is absent', async () => {
    const platformRoot = path.join(tmpDir, 'c-platform')
    const projectRoot = path.join(tmpDir, 'c-project')
    makePlatformDir(platformRoot)
    const result = await load(platformRoot, projectRoot)
    expect(result.platformConfig.adapters).toEqual({})
    expect(result.sources.generated).toBeUndefined()
  })

  it('projects without adapter config inherit the installer filesystem storage default', async () => {
    const platformRoot = path.join(tmpDir, 'storage-default-platform')
    const projectRoot = path.join(tmpDir, 'storage-default-project')
    makePlatformDir(platformRoot)
    write(platformRoot, '.kb/generated/adapters.json', {
      platform: {
        adapters: {
          storage: '@kb-labs/adapters-fs@2.120.1',
          cache: '@kb-labs/adapters-state-broker@2.120.1',
        },
        adapterOptions: {
          storage: { baseDir: 'storage' },
        },
      },
    })
    const result = await load(platformRoot, projectRoot)

    expect(result.platformConfig.adapters?.storage).toBe('@kb-labs/adapters-fs@2.120.1')
    expect(result.platformConfig.adapters?.cache).toBe('@kb-labs/adapters-state-broker@2.120.1')
    expect(result.platformConfig.adapterOptions?.storage).toEqual({ baseDir: 'storage' })
    expect(result.platformConfig.adapterOptions?.cache).toBeUndefined()
  })

  it('rejects a malformed generated config file', async () => {
    const platformRoot = path.join(tmpDir, 'd-platform')
    const projectRoot = path.join(tmpDir, 'd-project')
    makePlatformDir(platformRoot)
    write(platformRoot, '.kb/generated/broken.json', '{ nope')
    await expect(load(platformRoot, projectRoot)).rejects.toMatchObject({
      name: 'PlatformConfigError',
      reason: 'parse',
      configPath: realpathSync(path.join(platformRoot, '.kb/generated/broken.json')),
    })
  })
})
