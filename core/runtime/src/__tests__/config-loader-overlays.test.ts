import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { AdapterProjectScopeError, PlatformConfigError } from '@kb-labs/core-platform'
import { createProjectRegistry } from '@kb-labs/core-project-registry'
import { loadPlatformConfig } from '../config-loader.js'
import { writeTestPlatformReceipt } from './platform-version-fixture.js'

let tmpDir: string

function makePlatformDir(dir: string, configContents?: unknown): void {
  writeTestPlatformReceipt(dir)
  mkdirSync(path.join(dir, 'node_modules', '@kb-labs', 'cli-bin'), { recursive: true })
  if (configContents !== undefined) {
    mkdirSync(path.join(dir, '.kb'), { recursive: true })
    writeFileSync(path.join(dir, '.kb', 'kb.config.json'), JSON.stringify(configContents))
  }
}

function makeProjectDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
}

async function projectRegistration(projectRoot: string) {
  const env = { KB_HOME: path.join(tmpDir, 'kb-home') }
  const root = realpathSync(projectRoot)
  const registry = createProjectRegistry({ env })
  const existing = (await registry.list()).projects.find((entry) => entry.project.path === root)
  const project = existing?.project ?? (await registry.add(root)).project
  return { env, projectId: project.id }
}

async function writeOverlay(projectRoot: string, name: string, contents: string): Promise<string> {
  const { projectId } = await projectRegistration(projectRoot)
  const dir = path.join(tmpDir, 'kb-home', 'state', projectId, 'overlays')
  mkdirSync(dir, { recursive: true })
  const full = path.join(dir, name)
  writeFileSync(full, contents)
  return full
}

async function writeProjectSettings(projectRoot: string, contents: unknown): Promise<void> {
  const { projectId } = await projectRegistration(projectRoot)
  const dir = path.join(tmpDir, 'kb-home', 'state', projectId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'config.jsonc'), JSON.stringify(contents))
}

describe('loadPlatformConfig: overlays', () => {
  let originalCwd: string

  async function loadConfig(options: Parameters<typeof loadPlatformConfig>[0]) {
    const env: NodeJS.ProcessEnv = { ...options?.env, KB_HOME: path.join(tmpDir, 'kb-home') }
    if (env.KB_PLATFORM_ROOT) env.KB_PLATFORM_ROOT = realpathSync(env.KB_PLATFORM_ROOT)
    const startDir = realpathSync(options?.startDir ?? process.cwd())
    const registration = await projectRegistration(startDir)
    return loadPlatformConfig({ ...options, startDir, env, projectId: registration.projectId })
  }

  beforeAll(() => {
    originalCwd = process.cwd()
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'kb-cfg-overlays-'))
  })

  afterEach(() => process.chdir(tmpDir))

  afterAll(() => {
    process.chdir(originalCwd)
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns sources.overlays undefined when no overlays directory exists', async () => {
    const platformRoot = path.join(tmpDir, 'o1-platform')
    const projectRoot = path.join(tmpDir, 'o1-project')
    makePlatformDir(platformRoot, { platform: { adapters: { llm: 'openai' } } })
    makeProjectDir(projectRoot)

    const result = await loadConfig({
      startDir: projectRoot,
      env: { KB_PLATFORM_ROOT: platformRoot },
      loadEnvFile: false,
    })

    expect(result.platformConfig.adapters).toEqual({ llm: 'openai' })
    expect(result.sources.overlays).toBeUndefined()
  })

  it('applies a delivery config overlay over the image composition', async () => {
    const platformRoot = path.join(tmpDir, 'delivery-platform')
    const projectRoot = path.join(tmpDir, 'delivery-project')
    makePlatformDir(platformRoot, {
      platform: { deployment: { topology: 'cloud' }, adapters: { cache: 'redis' } },
      gateway: { access: { mode: 'secured' }, port: 4000 },
    })
    makeProjectDir(projectRoot)
    writeFileSync(path.join(platformRoot, '.kb', 'kb.config.override.json'), JSON.stringify({
      platform: { deployment: { topology: 'k8s' } },
      gateway: { access: { mode: 'secured' } },
    }))

    const result = await loadConfig({
      startDir: projectRoot,
      env: { KB_PLATFORM_ROOT: platformRoot },
      loadEnvFile: false,
    })

    expect(result.effectiveConfig?.platform).toMatchObject({
      deployment: { topology: 'k8s' },
      adapters: { cache: 'redis' },
    })
    expect(result.effectiveConfig?.gateway).toMatchObject({
      access: { mode: 'secured' },
      port: 4000,
    })
  })

  it('applies a delivery config overlay in a same-directory development checkout', async () => {
    const platformRoot = path.join(tmpDir, 'delivery-same-root')
    makePlatformDir(platformRoot, {
      platform: { deployment: { topology: 'cloud' }, adapters: { cache: 'redis' } },
      gateway: { access: { mode: 'secured' }, port: 4000 },
    })
    writeFileSync(path.join(platformRoot, '.kb', 'kb.config.override.json'), JSON.stringify({
      platform: { deployment: { topology: 'k8s' } },
    }))

    const result = await loadConfig({
      startDir: platformRoot,
      env: { KB_PLATFORM_ROOT: platformRoot },
      loadEnvFile: false,
    })

    expect(result.effectiveConfig).toEqual({
      plugins: {},
      platform: {
        deployment: { topology: 'k8s' },
        adapters: { cache: 'redis' },
      },
      gateway: { access: { mode: 'secured' }, port: 4000 },
    })
  })

  it('keeps effective config byte-identical to the image config when the delivery overlay is absent', async () => {
    const platformRoot = path.join(tmpDir, 'delivery-no-overlay')
    const projectRoot = path.join(tmpDir, 'delivery-no-overlay-project')
    const imageConfig = {
      platform: { deployment: { topology: 'cloud' }, adapters: { cache: 'redis' } },
      gateway: { access: { mode: 'secured' }, port: 4000 },
    }
    makePlatformDir(platformRoot, imageConfig)
    makeProjectDir(projectRoot)

    const result = await loadConfig({
      startDir: projectRoot,
      env: { KB_PLATFORM_ROOT: platformRoot },
      loadEnvFile: false,
    })

    expect(JSON.stringify(result.effectiveConfig)).toBe(JSON.stringify({ plugins: {}, ...imageConfig }))
  })

  it('applies overlays to platform data while leaving adapter values platform-owned', async () => {
    const platformRoot = path.join(tmpDir, 'o2-platform')
    const projectRoot = path.join(tmpDir, 'o2-project')
    makePlatformDir(platformRoot, { platform: { adapters: { llm: 'openai' }, features: { rerank: false } } })
    makeProjectDir(projectRoot)
    const overlayPath = await writeOverlay(projectRoot, 'pressure__overlay.jsonc', '{ "platform": { "features": { "rerank": true } } }')

    const result = await loadConfig({
      startDir: projectRoot,
      env: { KB_PLATFORM_ROOT: platformRoot },
      loadEnvFile: false,
    })

    expect(result.platformConfig.adapters).toEqual({ llm: 'openai' })
    expect((result.platformConfig.platform as Record<string, unknown>)?.features).toEqual({ rerank: true })
    expect(result.sources.overlays).toEqual([overlayPath])
  })

  it('merges multiple overlays in lexicographic order', async () => {
    const platformRoot = path.join(tmpDir, 'o3-platform')
    const projectRoot = path.join(tmpDir, 'o3-project')
    makePlatformDir(platformRoot, { platform: { features: { mode: 'base', keep: true } } })
    makeProjectDir(projectRoot)
    const aPath = await writeOverlay(projectRoot, 'a.jsonc', '{ "platform": { "features": { "mode": "first" } } }')
    const bPath = await writeOverlay(projectRoot, 'b.jsonc', '{ "platform": { "features": { "mode": "last", "added": true } } }')

    const result = await loadConfig({
      startDir: projectRoot,
      env: { KB_PLATFORM_ROOT: platformRoot },
      loadEnvFile: false,
    })

    expect((result.platformConfig.platform as Record<string, unknown>)?.features).toEqual({ mode: 'last', added: true })
    expect(result.sources.overlays).toEqual([aPath, bPath])
  })

  it('effectiveConfig applies overlays to product sections; rawConfig stays raw', async () => {
    const platformRoot = path.join(tmpDir, 'o-eff-platform')
    const projectRoot = path.join(tmpDir, 'o-eff-project')
    makePlatformDir(platformRoot)
    makeProjectDir(projectRoot)
    await writeProjectSettings(projectRoot, { plugins: { mind: { retrieval: { rerank: true } } } })
    await writeOverlay(projectRoot, 'hyde__overlay.jsonc', '{ "plugins": { "mind": { "retrieval": { "hyde": true } } } }')

    const result = await loadConfig({
      startDir: projectRoot,
      env: { KB_PLATFORM_ROOT: platformRoot },
      loadEnvFile: false,
    })

    const effectivePlugins = result.effectiveConfig?.plugins as Record<string, { retrieval: Record<string, unknown> }> | undefined
    expect(effectivePlugins?.mind?.retrieval).toEqual({ rerank: true, hyde: true })
    expect(result.rawConfig).toBeUndefined()
  })

  it('rejects a project overlay that attempts to set adapters', async () => {
    const platformRoot = path.join(tmpDir, 'o4-platform')
    const projectRoot = path.join(tmpDir, 'o4-project')
    makePlatformDir(platformRoot)
    makeProjectDir(projectRoot)
    await writeOverlay(projectRoot, 'adapter.jsonc', '{ "adapters": { "llm": "anthropic" } }')

    await expect(loadConfig({
      startDir: projectRoot,
      env: { KB_PLATFORM_ROOT: platformRoot },
      loadEnvFile: false,
    })).rejects.toBeInstanceOf(AdapterProjectScopeError)
  })

  it('throws when an overlay breaks the platform config top-level type', async () => {
    const platformRoot = path.join(tmpDir, 'o5-platform')
    const projectRoot = path.join(tmpDir, 'o5-project')
    makePlatformDir(platformRoot)
    makeProjectDir(projectRoot)
    await writeOverlay(projectRoot, 'bad.jsonc', '{ "execution": "not-an-object" }')

    await expect(loadConfig({
      startDir: projectRoot,
      env: { KB_PLATFORM_ROOT: platformRoot },
      loadEnvFile: false,
    })).rejects.toThrow(/Platform config is invalid after applying overlays/)
  })

  it('rejects a non-object overlay config file', async () => {
    const platformRoot = path.join(tmpDir, 'o6-platform')
    const projectRoot = path.join(tmpDir, 'o6-project')
    makePlatformDir(platformRoot)
    makeProjectDir(projectRoot)
    await writeOverlay(projectRoot, 'a-good.jsonc', '{ "platform": { "features": { "mode": "safe" } } }')
    await writeOverlay(projectRoot, 'c-array.jsonc', '[1, 2, 3]')

    await expect(loadConfig({
      startDir: projectRoot,
      env: { KB_PLATFORM_ROOT: platformRoot },
      loadEnvFile: false,
    })).rejects.toMatchObject({ name: 'PlatformConfigError', reason: 'invalid' })
  })

  it('rejects malformed and unreadable platform-state overlays with typed config errors', async () => {
    const platformRoot = path.join(tmpDir, 'o8-platform')
    const projectRoot = path.join(tmpDir, 'o8-project')
    makePlatformDir(platformRoot)
    makeProjectDir(projectRoot)
    const malformedPath = await writeOverlay(projectRoot, 'broken.jsonc', '{ invalid')

    await expect(loadConfig({
      startDir: projectRoot,
      env: { KB_PLATFORM_ROOT: platformRoot },
      loadEnvFile: false,
    })).rejects.toMatchObject({ name: 'PlatformConfigError', reason: 'parse', configPath: malformedPath })

    const unreadableProjectRoot = path.join(tmpDir, 'o9-project')
    makeProjectDir(unreadableProjectRoot)
    const unreadablePath = await writeOverlay(unreadableProjectRoot, 'unreadable.jsonc', '{}')
    rmSync(unreadablePath)
    mkdirSync(unreadablePath)

    await expect(loadConfig({
      startDir: unreadableProjectRoot,
      env: { KB_PLATFORM_ROOT: platformRoot },
      loadEnvFile: false,
    })).rejects.toMatchObject({ name: 'PlatformConfigError', reason: 'read', configPath: unreadablePath })
  })

  it('rejects malformed, unreadable, and non-object project settings with typed config errors', async () => {
    const platformRoot = path.join(tmpDir, 'o10-platform')
    const projectRoot = path.join(tmpDir, 'o10-project')
    makePlatformDir(platformRoot)
    makeProjectDir(projectRoot)

    const registration = await projectRegistration(projectRoot)
    const stateDir = path.join(tmpDir, 'kb-home', 'state', registration.projectId)
    mkdirSync(stateDir, { recursive: true })
    const settingsPath = path.join(stateDir, 'config.jsonc')
    writeFileSync(settingsPath, '{ invalid')
    const options = {
      startDir: projectRoot,
      env: { KB_PLATFORM_ROOT: platformRoot },
      loadEnvFile: false,
    }

    await expect(loadConfig(options)).rejects.toMatchObject({ name: 'PlatformConfigError', reason: 'parse', configPath: settingsPath })

    writeFileSync(settingsPath, '[]')
    await expect(loadConfig(options)).rejects.toMatchObject({ name: 'PlatformConfigError', reason: 'invalid', configPath: settingsPath })

    rmSync(settingsPath)
    mkdirSync(settingsPath)
    await expect(loadConfig(options)).rejects.toMatchObject({ name: 'PlatformConfigError', reason: 'read', configPath: settingsPath })
  })

  it('omits overlayDiagnostics when there are no issues', async () => {
    const platformRoot = path.join(tmpDir, 'o7-platform')
    const projectRoot = path.join(tmpDir, 'o7-project')
    makePlatformDir(platformRoot)
    makeProjectDir(projectRoot)
    await writeOverlay(projectRoot, 'p.jsonc', '{ "platform": { "features": { "mode": "safe" } } }')

    const result = await loadConfig({
      startDir: projectRoot,
      env: { KB_PLATFORM_ROOT: platformRoot },
      loadEnvFile: false,
    })

    expect(result.sources.overlayDiagnostics).toBeUndefined()
  })
})
