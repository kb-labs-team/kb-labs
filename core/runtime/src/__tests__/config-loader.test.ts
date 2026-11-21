import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'

import { loadPlatformConfig } from '../config-loader.js'
import { createProjectRegistry } from '@kb-labs/core-project-registry'
import { writeTestPlatformReceipt } from './platform-version-fixture.js'

/**
 * Create a minimal platform installation layout at `<dir>`:
 *   <dir>/node_modules/@kb-labs/cli-bin/
 *   <dir>/.kb/kb.config.json (optional)
 */
function makePlatformDir(dir: string, configContents?: unknown): void {
  writeTestPlatformReceipt(dir)
  mkdirSync(path.join(dir, 'node_modules', '@kb-labs', 'cli-bin'), {
    recursive: true,
  })
  if (configContents !== undefined) {
    mkdirSync(path.join(dir, '.kb'), { recursive: true })
    writeFileSync(
      path.join(dir, '.kb', 'kb.config.json'),
      JSON.stringify(configContents),
    )
  }
}

/**
 * Create a minimal user project layout at `<dir>`:
 *   <dir>/.kb/kb.config.json (optional)
 */
function makeProjectDir(dir: string, configContents?: unknown): void {
  mkdirSync(dir, { recursive: true })
  if (configContents !== undefined) {
    mkdirSync(path.join(dir, '.kb'), { recursive: true })
    writeFileSync(
      path.join(dir, '.kb', 'kb.config.json'),
      JSON.stringify(configContents),
    )
  }
}

describe('loadPlatformConfig', () => {
  let tmpDir: string
  let originalCwd: string
  async function loadConfig(options: Parameters<typeof loadPlatformConfig>[0]) {
    const env: NodeJS.ProcessEnv = { ...options?.env, KB_HOME: path.join(tmpDir, 'kb-home') }
    if (env.KB_PLATFORM_ROOT) env.KB_PLATFORM_ROOT = realpathSync(env.KB_PLATFORM_ROOT)
    const startDir = realpathSync(options?.startDir ?? process.cwd())
    const registry = createProjectRegistry({ env })
  const existing = (await registry.list()).projects.find((entry) => entry.project.path === startDir)
    const project = existing?.project ?? (await registry.add(startDir)).project
    return loadPlatformConfig({ ...options, startDir, env, projectId: project.id })
  }

  beforeAll(() => {
    originalCwd = process.cwd()
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'kb-cfg-'))
  })

  afterEach(() => {
    process.chdir(tmpDir)
  })

  afterAll(() => {
    process.chdir(originalCwd)
    rmSync(tmpDir, { recursive: true, force: true })
  })

  // case: S-287.6
  it('keeps the launcher platform root when platform configuration points elsewhere', async () => {
    const platformRoot = path.join(tmpDir, 'declared-platform')
    const otherRoot = path.join(tmpDir, 'other-platform')
    const projectRoot = path.join(tmpDir, 'root-owner-project')
    makePlatformDir(otherRoot)
    makePlatformDir(platformRoot, { platform: { dir: otherRoot } })
    makeProjectDir(projectRoot)
    const result = await loadConfig({ startDir: projectRoot, env: { KB_PLATFORM_ROOT: platformRoot }, loadEnvFile: false })
    expect(result.platformRoot).toBe(realpathSync(platformRoot))
  })

  // case: S-287.5
  it('discovers development adapters only from the platform with distinct roots', async () => {
    const platformRoot = path.join(tmpDir, 'adapter-owner-platform')
    const projectRoot = path.join(tmpDir, 'adapter-owner-project')
    makePlatformDir(platformRoot, { platform: { mode: 'development' } })
    makeProjectDir(projectRoot)
    const adapterRoot = path.join(projectRoot, 'adapters', 'project-only')
    mkdirSync(adapterRoot, { recursive: true })
    writeFileSync(path.join(projectRoot, 'pnpm-workspace.yaml'), 'packages:\n  - "adapters/*"\n')
    writeFileSync(path.join(adapterRoot, 'package.json'), JSON.stringify({
      name: '@example/project-only', version: '1.0.0',
      kb: { adapter: { manifest: './dist/manifest.js' } },
    }))

    const result = await loadConfig({ startDir: projectRoot, env: { KB_PLATFORM_ROOT: platformRoot }, loadEnvFile: false })
    expect(result.catalog.adapters().has('@example/project-only')).toBe(false)
  })

  // case: S-048.1
  it('ignores repository configuration, including project adapter bindings', async () => {
    const platformRoot = path.join(tmpDir, 'p1-platform')
    const projectRoot = path.join(tmpDir, 'p1-project')
    makePlatformDir(platformRoot) // no config
    makeProjectDir(projectRoot, {
      platform: {
        adapters: { llm: 'noop' },
      },
    })

    const result = await loadConfig({
      startDir: projectRoot,
      env: {
        KB_PLATFORM_ROOT: platformRoot,
      },
      loadEnvFile: false,
    })
    expect(result.platformConfig).toEqual({ adapters: {} })
  })

  it('ignores legacy top-level repository adapter sections', async () => {
    const platformRoot = path.join(tmpDir, 'p1-legacy-platform')
    const projectRoot = path.join(tmpDir, 'p1-legacy-project')
    makePlatformDir(platformRoot)
    makeProjectDir(projectRoot, { adapters: { llm: ['openai'] } })

    const result = await loadConfig({
      startDir: projectRoot,
      env: { KB_PLATFORM_ROOT: platformRoot },
      loadEnvFile: false,
    })
    expect(result.platformConfig).toEqual({ adapters: {} })
  })

  it('keeps platform defaults when repository adapter options are present', async () => {
    const platformRoot = path.join(tmpDir, 'p-platform-only')
    const projectRoot = path.join(tmpDir, 'p-project-only')
    makePlatformDir(platformRoot, { platform: { adapters: { llm: 'openai' } } })
    makeProjectDir(projectRoot, {
      platform: { adapterOptions: { llm: { model: 'project-model' } } },
    })

    const result = await loadConfig({
      startDir: projectRoot,
      env: { KB_PLATFORM_ROOT: platformRoot },
      loadEnvFile: false,
    })
    expect(result.platformConfig.adapters).toEqual({ llm: 'openai' })
  })

  it('loads only platform defaults when project has no config', async () => {
    const platformRoot = path.join(tmpDir, 'p2-platform')
    const projectRoot = path.join(tmpDir, 'p2-project')
    makePlatformDir(platformRoot, {
      platform: {
        adapters: { cache: 'redis' },
      },
    })
    makeProjectDir(projectRoot) // no config

    const result = await loadConfig({
      startDir: projectRoot,
      env: {
        KB_PLATFORM_ROOT: platformRoot,
      },
      loadEnvFile: false,
    })

    expect(result.platformConfig.adapters).toEqual({ cache: 'redis' })
    expect(result.sources.platformDefaults).toBe(
      realpathSync(path.join(platformRoot, '.kb', 'kb.config.json')),
    )
    expect(result.sources.projectConfig).toBeUndefined()
  })

  it('does not merge repository adapter bindings into platform config', async () => {
    const platformRoot = path.join(tmpDir, 'p3-platform')
    const projectRoot = path.join(tmpDir, 'p3-project')
    makePlatformDir(platformRoot, {
      platform: {
        adapters: {
          llm: 'openai',
          cache: 'redis',
        },
      },
    })
    makeProjectDir(projectRoot, {
      platform: {
        adapters: {
          llm: 'anthropic', // project-level adapter configuration is rejected
        },
      },
    })

    const result = await loadConfig({
      startDir: projectRoot,
      env: {
        KB_PLATFORM_ROOT: platformRoot,
      },
      loadEnvFile: false,
    })
    expect(result.platformConfig.adapters).toEqual({ llm: 'openai', cache: 'redis' })
  })

  it('returns empty-adapters base when neither layer exists', async () => {
    const platformRoot = path.join(tmpDir, 'p4-platform')
    const projectRoot = path.join(tmpDir, 'p4-project')
    makePlatformDir(platformRoot) // no config
    makeProjectDir(projectRoot) // no config

    const result = await loadConfig({
      startDir: projectRoot,
      env: {
        KB_PLATFORM_ROOT: platformRoot,
      },
      loadEnvFile: false,
    })

    // Base is { adapters: {} } so downstream code can always destructure it.
    expect(result.platformConfig).toEqual({ adapters: {} })
    expect(result.sources.platformDefaults).toBeUndefined()
    expect(result.sources.projectConfig).toBeUndefined()
  })

  it('reads single file once when platformRoot === projectRoot (dev mode)', async () => {
    const workspaceRoot = path.join(tmpDir, 'p5-workspace')
    makePlatformDir(workspaceRoot, {
      platform: {
        adapters: { llm: 'workspace-llm' },
      },
    })

    const result = await loadConfig({
      startDir: workspaceRoot,
      env: {
        KB_PLATFORM_ROOT: workspaceRoot,
      },
      loadEnvFile: false,
    })

    expect(result.sameLocation).toBe(true)
    expect(result.platformConfig.adapters).toEqual({ llm: 'workspace-llm' })
    expect(result.sources.platformDefaults).toBe(
      realpathSync(path.join(workspaceRoot, '.kb', 'kb.config.json')),
    )
    expect(result.sources.projectConfig).toBeUndefined()
  })

  it('reports no ignored fields when platformRoot === projectRoot, even for platform-only fields', async () => {
    // sameLocation: true is the monorepo/dogfooding case — one physical file
    // plays both roles, so the platform<->project merge is a no-op and
    // nothing can conflict. This guards against the merge policy accidentally
    // treating the single file's own platform-only fields (e.g. `execution`)
    // as a rejected project override of itself.
    const workspaceRoot = path.join(tmpDir, 'p5b-workspace')
    makePlatformDir(workspaceRoot, {
      platform: {
        adapters: { llm: 'workspace-llm' },
        execution: { mode: 'worker-pool' },
      },
    })

    const result = await loadConfig({
      startDir: workspaceRoot,
      env: {
        KB_PLATFORM_ROOT: workspaceRoot,
      },
      loadEnvFile: false,
    })

    expect(result.sameLocation).toBe(true)
    expect(result.sources.ignoredProjectFields).toBeUndefined()
    // Every resolved field is attributed to the single (platform) layer —
    // there's no separate project layer to merge against in this mode.
    expect(result.sources.fields).toEqual({
      adapters: 'platform',
      execution: 'platform',
    })
  })

  it('returns empty defaults when optional config layers are absent', async () => {
    const platformRoot = path.join(tmpDir, 'p6-platform-absent')
    const projectRoot = path.join(tmpDir, 'p6-project-absent')
    makePlatformDir(platformRoot)
    makeProjectDir(projectRoot)

    const result = await loadConfig({
      startDir: projectRoot,
      env: { KB_PLATFORM_ROOT: platformRoot, KB_PROJECT_ROOT: projectRoot },
      loadEnvFile: false,
    })

    expect(result.platformConfig).toEqual({ adapters: {} })
    expect(result.sources.platformDefaults).toBeUndefined()
    expect(result.sources.projectConfig).toBeUndefined()
  })

  it('rejects malformed JSON in platform config with a typed config error', async () => {
    const platformRoot = path.join(tmpDir, 'p6-platform')
    const projectRoot = path.join(tmpDir, 'p6-project')
    makePlatformDir(platformRoot)
    makeProjectDir(projectRoot)
    mkdirSync(path.join(platformRoot, '.kb'), { recursive: true })
    writeFileSync(
      path.join(platformRoot, '.kb', 'kb.config.json'),
      '{ this is not: valid json',
    )

    const configPath = path.join(platformRoot, '.kb', 'kb.config.json')
    await expect(loadConfig({
      startDir: projectRoot,
      env: {
        KB_PLATFORM_ROOT: platformRoot,
      },
      loadEnvFile: false,
    })).rejects.toMatchObject({
      name: 'PlatformConfigError',
      reason: 'parse',
      configPath: realpathSync(configPath),
    })
  })

  it('rejects config paths that cannot be read', async () => {
    const platformRoot = path.join(tmpDir, 'p6-unreadable-platform')
    const projectRoot = path.join(tmpDir, 'p6-unreadable-project')
    makePlatformDir(platformRoot)
    makeProjectDir(projectRoot)
    const configPath = path.join(platformRoot, '.kb', 'kb.config.json')
    mkdirSync(path.dirname(configPath), { recursive: true })
    mkdirSync(configPath)

    await expect(loadConfig({
      startDir: projectRoot,
      env: { KB_PLATFORM_ROOT: platformRoot, KB_PROJECT_ROOT: projectRoot },
      loadEnvFile: false,
    })).rejects.toMatchObject({
      name: 'PlatformConfigError',
      reason: 'read',
      configPath: realpathSync(configPath),
    })
  })

  it('rejects structurally invalid platform configuration with a typed config error', async () => {
    const platformRoot = path.join(tmpDir, 'p6-invalid-platform')
    const projectRoot = path.join(tmpDir, 'p6-invalid-project')
    makePlatformDir(platformRoot, { platform: { adapters: 'not-an-object' } })
    makeProjectDir(projectRoot)
    const configPath = path.join(platformRoot, '.kb', 'kb.config.json')

    await expect(loadConfig({
      startDir: projectRoot,
      env: { KB_PLATFORM_ROOT: platformRoot, KB_PROJECT_ROOT: projectRoot },
      loadEnvFile: false,
    })).rejects.toMatchObject({ name: 'PlatformConfigError', reason: 'invalid', configPath: realpathSync(configPath) })
  })

  it('rejects malformed generated and overlay config layers', async () => {
    const platformRoot = path.join(tmpDir, 'p6-generated-platform')
    const projectRoot = path.join(tmpDir, 'p6-generated-project')
    makePlatformDir(platformRoot)
    makeProjectDir(projectRoot)
    const generatedPath = path.join(platformRoot, '.kb', 'generated', 'base.json')
    mkdirSync(path.dirname(generatedPath), { recursive: true })
    writeFileSync(generatedPath, '{ invalid')

    await expect(loadConfig({
      startDir: projectRoot,
      env: { KB_PLATFORM_ROOT: platformRoot, KB_PROJECT_ROOT: projectRoot },
      loadEnvFile: false,
    })).rejects.toMatchObject({ name: 'PlatformConfigError', reason: 'parse', configPath: realpathSync(generatedPath) })

    const overlayPlatformRoot = path.join(tmpDir, 'p6-overlay-platform')
    const overlayRoot = path.join(tmpDir, 'p6-overlay-project')
    makePlatformDir(overlayPlatformRoot)
    makeProjectDir(overlayRoot)
    const env = { KB_HOME: path.join(tmpDir, 'kb-home') }
    const registration = await createProjectRegistry({ env }).add(realpathSync(overlayRoot))
    const overlayPath = path.join(env.KB_HOME, 'state', registration.project.id, 'overlays', 'broken.jsonc')
    mkdirSync(path.dirname(overlayPath), { recursive: true })
    writeFileSync(overlayPath, '{ invalid')

    await expect(loadConfig({
      startDir: overlayRoot,
      env: { ...env, KB_PLATFORM_ROOT: overlayPlatformRoot },
      loadEnvFile: false,
    })).rejects.toMatchObject({ name: 'PlatformConfigError', reason: 'parse', configPath: overlayPath })
  })

  it('tolerates config without a `platform` section', async () => {
    const platformRoot = path.join(tmpDir, 'p7-platform')
    const projectRoot = path.join(tmpDir, 'p7-project')
    makePlatformDir(platformRoot)
    makeProjectDir(projectRoot, { unrelated: 'data' })

    const result = await loadConfig({
      startDir: projectRoot,
      env: {
        KB_PLATFORM_ROOT: platformRoot,
      },
      loadEnvFile: false,
    })

    expect(result.platformConfig).toEqual({ adapters: {} })
    expect(result.rawConfig).toBeUndefined()
  })

  // case: S-204.10
  it('loads plugin overrides by registered project ID and ignores repository config', async () => {
    const platformRoot = path.join(tmpDir, 'p7-settings-platform')
    const projectRoot = path.join(tmpDir, 'p7-settings-project')
    const platformHome = path.join(tmpDir, 'p7-settings-home')
    makePlatformDir(platformRoot, { plugins: { commit: { scope: { scopes: [{ id: 'shared' }] } } } })
    makeProjectDir(projectRoot, { plugins: { commit: { scope: { scopes: [{ id: 'legacy' }] } } } })
    const env = { KB_PLATFORM_ROOT: realpathSync(platformRoot), KB_HOME: platformHome }
    const registration = await createProjectRegistry({ env }).add(realpathSync(projectRoot))
    const stateDir = path.join(platformHome, 'state', registration.project.id)
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(path.join(stateDir, 'config.jsonc'), JSON.stringify({
      plugins: { commit: { scope: { scopes: [{ id: 'project' }] } } },
    }))

    const result = await loadPlatformConfig({
      startDir: projectRoot,
      env: {
        ...env,
      },
      projectId: registration.project.id,
      loadEnvFile: false,
    })

    expect(result.effectiveConfig?.plugins).toEqual({ commit: { scope: { scopes: [{ id: 'project' }] } } })
    expect(JSON.parse(readFileSync(path.join(projectRoot, '.kb', 'kb.config.json'), 'utf8')))
      .toEqual({ plugins: { commit: { scope: { scopes: [{ id: 'legacy' }] } } } })
  })

  // case: S-100.2
  it('loads explicit platform scope without a registered project', async () => {
    const platformRoot = path.join(tmpDir, 'p7-platform-scope-platform')
    const startDir = path.join(tmpDir, 'p7-platform-scope-outside')
    const platformHome = path.join(tmpDir, 'p7-platform-scope-home')
    makePlatformDir(platformRoot)
    mkdirSync(startDir, { recursive: true })
    const projectState = path.join(platformHome, 'state', 'ambient-project')
    mkdirSync(projectState, { recursive: true })
    writeFileSync(path.join(projectState, 'config.jsonc'), JSON.stringify({ plugins: { commit: { enabled: true } } }))

    const result = await loadPlatformConfig({
      startDir,
      projectScope: 'platform',
      env: {
        KB_PLATFORM_ROOT: realpathSync(platformRoot),
        KB_HOME: platformHome,
      },
      loadEnvFile: false,
    })

    expect((result.effectiveConfig?.plugins as Record<string, unknown> | undefined)?.commit).toBeUndefined()
    expect(result.sources.overlays).toBeUndefined()
    expect(result.projectRoot).toBeUndefined()
    expect(result.projectScope).toBe('platform')
  })

  it('keeps platform config scope at the platform root while reporting a registered project separately', async () => {
    const platformRoot = path.join(tmpDir, 'platform-scope-registered-platform')
    const projectRoot = path.join(tmpDir, 'platform-scope-registered-project')
    const home = path.join(tmpDir, 'platform-scope-registered-home')
    makePlatformDir(platformRoot, { platform: { adapters: { cache: '@kb-labs/platform-cache' } } })
    makeProjectDir(projectRoot, { platform: { adapters: { cache: '@kb-labs/project-cache' } } })
    const registered = await createProjectRegistry({ env: { KB_HOME: home } }).add(realpathSync(projectRoot))

    const result = await loadPlatformConfig({
      startDir: projectRoot,
      projectScope: 'platform',
      env: { KB_PLATFORM_ROOT: realpathSync(platformRoot), KB_HOME: home },
      loadEnvFile: false,
    })

    expect(result.platformRoot).toBe(realpathSync(platformRoot))
    expect(result.projectRoot).toBe(registered.project.path)
    expect(result.projectScope).toBe('platform')
    expect(result.platformConfig.adapters).toEqual({ cache: '@kb-labs/platform-cache' })
  })

  // case: S-124.12
  it('rejects an explicit project id when its registered path differs from the runtime path', async () => {
    const platformHome = path.join(tmpDir, 'runtime-identity-home')
    const registeredRoot = path.join(tmpDir, 'runtime-identity-registered')
    const requestedRoot = path.join(tmpDir, 'runtime-identity-requested')
    makeProjectDir(registeredRoot)
    makeProjectDir(requestedRoot)
    const env = { KB_HOME: platformHome }
    const registered = await createProjectRegistry({ env }).add(realpathSync(registeredRoot))

    await expect(loadPlatformConfig({
      startDir: requestedRoot,
      projectScope: 'required',
      projectId: registered.project.id,
      env,
      loadEnvFile: false,
    })).rejects.toMatchObject({
      code: 'KB_PROJECT_RUNTIME_IDENTITY_MISMATCH',
    })
  })

  // case: S-198.5
  it('accepts an explicit project id when the runtime path is one of its git worktrees', async () => {
    const platformHome = path.join(tmpDir, 'runtime-worktree-home')
    const registeredRoot = path.join(tmpDir, 'runtime-worktree-registered')
    const externalParent = path.join(tmpDir, 'runtime-worktree-parent')
    const worktreeRoot = path.join(externalParent, 'checkout')
    mkdirSync(registeredRoot, { recursive: true })
    mkdirSync(externalParent, { recursive: true })
    execFileSync('git', ['init', '-b', 'main'], { cwd: registeredRoot })
    execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: registeredRoot })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: registeredRoot })
    writeFileSync(path.join(registeredRoot, 'README.md'), 'fixture\n')
    execFileSync('git', ['add', 'README.md'], { cwd: registeredRoot })
    execFileSync('git', ['commit', '-m', 'fixture'], { cwd: registeredRoot })
    execFileSync('git', ['worktree', 'add', '--detach', worktreeRoot, 'main'], { cwd: registeredRoot })
    makePlatformDir(worktreeRoot)
    const env = { KB_HOME: platformHome, KB_PLATFORM_ROOT: realpathSync(worktreeRoot) }
    const registered = await createProjectRegistry({ env }).add(realpathSync(registeredRoot))

    const loaded = await loadPlatformConfig({
      startDir: worktreeRoot,
      projectScope: 'required',
      projectId: registered.project.id,
      env,
      loadEnvFile: false,
    })
    expect(loaded.projectRoot).toBe(realpathSync(registeredRoot))
    expect(loaded.sources.roots).toMatchObject({
      project: 'worktree',
      projectStartDir: path.resolve(worktreeRoot),
    })
  })

  it('loads .env file from projectRoot when loadEnvFile is true', async () => {
    const platformRoot = path.join(tmpDir, 'p8-platform')
    const projectRoot = path.join(tmpDir, 'p8-project')
    makePlatformDir(platformRoot)
    makeProjectDir(projectRoot, { platform: {} })
    writeFileSync(
      path.join(projectRoot, '.env'),
      'KB_TEST_LOADED_VAR=from-env-file\n',
    )

    // Pre-condition
    delete process.env.KB_TEST_LOADED_VAR

    await loadConfig({
      startDir: projectRoot,
      env: {
        KB_PLATFORM_ROOT: platformRoot,
      },
      loadEnvFile: true,
    })

    expect(process.env.KB_TEST_LOADED_VAR).toBe('from-env-file')

    // Cleanup
    delete process.env.KB_TEST_LOADED_VAR
  })

  it('does not load .env when loadEnvFile is false', async () => {
    const platformRoot = path.join(tmpDir, 'p9-platform')
    const projectRoot = path.join(tmpDir, 'p9-project')
    makePlatformDir(platformRoot)
    makeProjectDir(projectRoot, { platform: {} })
    writeFileSync(
      path.join(projectRoot, '.env'),
      'KB_TEST_SHOULD_NOT_LOAD=nope\n',
    )

    delete process.env.KB_TEST_SHOULD_NOT_LOAD

    await loadConfig({
      startDir: projectRoot,
      env: {
        KB_PLATFORM_ROOT: platformRoot,
      },
      loadEnvFile: false,
    })

    expect(process.env.KB_TEST_SHOULD_NOT_LOAD).toBeUndefined()
  })

  it('throws on an unresolved ${VAR} placeholder when NODE_ENV=production', async () => {
    // A cloud deployment with a missing secret must crash at boot, not serve
    // traffic with a literal `${VAR}` baked into config (docs/adr/0037).
    const platformRoot = path.join(tmpDir, 'p10-platform')
    const projectRoot = path.join(tmpDir, 'p10-project')
    makePlatformDir(platformRoot, {
      platform: { adapters: { llm: '${MISSING_SECRET_VAR}' } },
    })
    makeProjectDir(projectRoot)

    delete process.env.MISSING_SECRET_VAR

    await expect(
      loadConfig({
        startDir: projectRoot,
        env: {
          KB_PLATFORM_ROOT: platformRoot,
            NODE_ENV: 'production',
        },
        loadEnvFile: false,
      }),
    ).rejects.toThrow(/MISSING_SECRET_VAR/)
  })

  it('leaves an unresolved ${VAR} placeholder intact outside production', async () => {
    const platformRoot = path.join(tmpDir, 'p11-platform')
    const projectRoot = path.join(tmpDir, 'p11-project')
    makePlatformDir(platformRoot, {
      platform: { adapters: { llm: '${MISSING_SECRET_VAR}' } },
    })
    makeProjectDir(projectRoot)

    delete process.env.MISSING_SECRET_VAR

    const result = await loadConfig({
      startDir: projectRoot,
      env: {
        KB_PLATFORM_ROOT: platformRoot,
      },
      loadEnvFile: false,
    })

    expect(result.platformConfig.adapters?.llm).toBe('${MISSING_SECRET_VAR}')
  })

  it('shifts loopback adapter infrastructure URLs with KB_NET_OFFSET', async () => {
    const workspaceRoot = path.join(tmpDir, 'p-net-offset-workspace')
    makePlatformDir(workspaceRoot, {
      platform: {
        adapters: { cache: 'redis', vectorStore: 'qdrant' },
        adapterOptions: {
          cache: { url: 'redis://localhost:6379' },
          vectorStore: { url: 'http://localhost:6333' },
          serviceTransport: {
            services: { workflow: { url: 'http://localhost:7778' } },
          },
        },
      },
    })

    const result = await loadConfig({
      startDir: workspaceRoot,
      env: {
        KB_PLATFORM_ROOT: workspaceRoot,
        KB_PROJECT_ROOT: workspaceRoot,
        KB_NET_OFFSET: '1000',
      },
      loadEnvFile: false,
    })

    expect(result.platformConfig.adapterOptions).toMatchObject({
      cache: { url: 'redis://localhost:7379' },
      vectorStore: { url: 'http://localhost:7333' },
      // The transport owns its own offset application, so it stays canonical
      // here and is shifted exactly once when the adapter is constructed.
      serviceTransport: {
        services: { workflow: { url: 'http://localhost:7778' } },
      },
    })
  })
})
