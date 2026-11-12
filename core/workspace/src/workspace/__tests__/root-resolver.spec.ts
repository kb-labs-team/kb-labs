import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { createProjectRegistry } from '@kb-labs/core-project-registry'

import {
  findRegisteredProjectRoot,
  resolvePlatformRoot,
  resolveProjectRoot,
  resolveRoots,
  resolveWorkspaceRoot,
} from '../root-resolver'

function createDeclaredLauncherCheckout(): { checkout: string; moduleUrl: string } {
  const checkout = mkdtempSync(path.join(os.tmpdir(), 'kb-launcher-checkout-'))
  const launcherPath = path.join(checkout, 'cli/bin/dist/bin.js')
  mkdirSync(path.dirname(launcherPath), { recursive: true })
  // Model pnpm's workspace symlink: without the explicit ownership declaration,
  // the resolver would stop at cli/bin and mistake it for the platform root.
  mkdirSync(path.join(checkout, 'cli/bin/node_modules/@kb-labs/cli-bin'), { recursive: true })
  writeFileSync(
    path.join(checkout, '.kb-platform-launch.json'),
    JSON.stringify({ launchers: ['cli/bin/dist/bin.js'] }),
  )
  return { checkout, moduleUrl: pathToFileURL(launcherPath).href }
}

describe('resolveProjectRoot', () => {
  let tmpDir: string
  let originalCwd: string

  beforeAll(() => {
    originalCwd = process.cwd()
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'kb-project-'))
  })

  afterEach(() => {
    process.chdir(tmpDir)
  })

  afterAll(() => {
    process.chdir(originalCwd)
    rmSync(tmpDir, { recursive: true, force: true })
  })

  // case: S-204.7
  it('reports an unknown project outside the platform registry', async () => {
    const unregistered = path.join(tmpDir, 'unregistered-project')
    const registryHome = path.join(tmpDir, 'registry-home')
    mkdirSync(unregistered, { recursive: true })
    await expect(resolveProjectRoot({
      startDir: unregistered,
      env: { KB_HOME: registryHome },
    })).rejects.toMatchObject({
      name: 'ErrorEnvelopeError',
      envelope: {
        code: 'KB_PROJECT_UNKNOWN',
        message: `The project ${path.resolve(unregistered)} is not in the registry (the folder may have moved).`,
        hint: `Register it with "kb project add ${path.resolve(unregistered)}".`,
      },
    })
  })

  it('resolves the registered project containing cwd without reading repository config', async () => {
    const project = path.join(tmpDir, 'registered-project')
    const nested = path.join(project, 'packages', 'foo')
    const home = path.join(tmpDir, 'registered-home')
    mkdirSync(nested, { recursive: true })
    await createProjectRegistry({ root: home }).add(project)

    const result = await resolveProjectRoot({ startDir: nested, env: { KB_HOME: home } })
    expect(result).toEqual({ rootDir: realpathSync(project), source: 'registry', cwdDir: path.resolve(nested) })
  })

  // case: S-198.7
  it('resolves a git worktree outside the registered project to its owning project', async () => {
    const project = path.join(tmpDir, 'registered-git-project')
    const worktreeParent = path.join(tmpDir, 'external-worktrees')
    const worktree = path.join(worktreeParent, 'feature')
    const home = path.join(tmpDir, 'registered-git-home')
    mkdirSync(project, { recursive: true })
    mkdirSync(worktreeParent, { recursive: true })
    execFileSync('git', ['init', '-b', 'main'], { cwd: project })
    execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: project })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: project })
    writeFileSync(path.join(project, 'README.md'), 'fixture\n')
    execFileSync('git', ['add', 'README.md'], { cwd: project })
    execFileSync('git', ['commit', '-m', 'fixture'], { cwd: project })
    execFileSync('git', ['worktree', 'add', '--detach', worktree, 'main'], { cwd: project })
    await createProjectRegistry({ root: home }).add(realpathSync(project))

    const result = await resolveProjectRoot({ startDir: worktree, env: { KB_HOME: home } })
    expect(result).toEqual({ rootDir: realpathSync(project), source: 'worktree', cwdDir: path.resolve(worktree) })
    const gitCalls: string[][] = []
    const injectedExec = async (file: string, args: string[], options: { cwd: string; timeout: number }) => {
      gitCalls.push([file, ...args])
      return { stdout: execFileSync(file, args, { cwd: options.cwd, encoding: 'utf8' }) }
    }
    expect(await findRegisteredProjectRoot(worktree, { KB_HOME: home }, injectedExec)).toBe(realpathSync(project))
    expect(gitCalls).toEqual([['git', 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir']])
    const roots = await resolveRoots({
      startDir: worktree,
      env: { KB_HOME: home, KB_PLATFORM_ROOT: path.join(tmpDir, 'worktree-platform') },
    })
    expect(roots.projectRoot).toBe(realpathSync(project))
    expect(roots.projectStartDir).toBe(path.resolve(worktree))
    expect(roots.sources).toMatchObject({ project: 'worktree', projectStartDir: path.resolve(worktree) })
  })

  it('maps worktree paths to the main checkout before matching a registered subdirectory', async () => {
    const repo = path.join(tmpDir, 'subdirectory-project-repo')
    const project = path.join(repo, 'packages', 'registered')
    const worktree = path.join(tmpDir, 'subdirectory-project-worktree')
    const inside = path.join(worktree, 'packages', 'registered', 'src')
    const outside = path.join(worktree, 'packages', 'other')
    const home = path.join(tmpDir, 'subdirectory-project-home')
    mkdirSync(project, { recursive: true })
    mkdirSync(path.join(repo, 'packages', 'other'), { recursive: true })
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
    writeFileSync(path.join(repo, 'README.md'), 'fixture\n')
    writeFileSync(path.join(project, 'package.json'), '{"name":"registered"}\n')
    writeFileSync(path.join(repo, 'packages', 'other', 'README.md'), 'outside\n')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'fixture'], { cwd: repo })
    execFileSync('git', ['worktree', 'add', '--detach', worktree, 'main'], { cwd: repo })
    mkdirSync(inside, { recursive: true })
    await createProjectRegistry({ root: home }).add(realpathSync(project))

    const calls: string[][] = []
    const injectedExec = async (file: string, args: string[], options: { cwd: string; timeout: number }) => {
      calls.push([file, ...args])
      return { stdout: execFileSync(file, args, { cwd: options.cwd, encoding: 'utf8' }) }
    }
    expect(await findRegisteredProjectRoot(inside, { KB_HOME: home }, injectedExec)).toBe(realpathSync(project))
    expect(calls).toHaveLength(1)
    calls.length = 0
    expect(await findRegisteredProjectRoot(outside, { KB_HOME: home }, injectedExec)).toBeUndefined()
    expect(calls).toHaveLength(1)
  })

  // case: S-198.7
  it('does not resolve an unregistered repository worktree by common dir', async () => {
    const repo = path.join(tmpDir, 'unregistered-git-project')
    const worktree = path.join(tmpDir, 'unregistered-git-worktree')
    const home = path.join(tmpDir, 'empty-git-home')
    mkdirSync(repo, { recursive: true })
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
    writeFileSync(path.join(repo, 'README.md'), 'fixture\n')
    execFileSync('git', ['add', 'README.md'], { cwd: repo })
    execFileSync('git', ['commit', '-m', 'fixture'], { cwd: repo })
    execFileSync('git', ['worktree', 'add', '--detach', worktree, 'main'], { cwd: repo })

    const calls: string[][] = []
    const injectedExec = async (file: string, args: string[], options: { cwd: string; timeout: number }) => {
      calls.push([file, ...args])
      return { stdout: execFileSync(file, args, { cwd: options.cwd, encoding: 'utf8' }) }
    }
    await expect(findRegisteredProjectRoot(worktree, { KB_HOME: home }, injectedExec)).resolves.toBeUndefined()
    expect(calls).toHaveLength(1)
    await expect(resolveProjectRoot({ startDir: worktree, env: { KB_HOME: home } }))
      .rejects.toMatchObject({ envelope: { code: 'KB_PROJECT_UNKNOWN' } })
  })

  it('does not resolve bare repositories or repositories with a nonstandard common directory', async () => {
    const bare = path.join(tmpDir, 'bare-project.git')
    const home = path.join(tmpDir, 'bare-project-home')
    mkdirSync(bare, { recursive: true })
    execFileSync('git', ['init', '--bare'], { cwd: bare })
    const bareCalls: string[][] = []
    const realExec = async (file: string, args: string[], options: { cwd: string; timeout: number }) => {
      bareCalls.push([file, ...args])
      return { stdout: execFileSync(file, args, { cwd: options.cwd, encoding: 'utf8' }) }
    }
    await expect(findRegisteredProjectRoot(bare, { KB_HOME: home }, realExec)).resolves.toBeUndefined()
    expect(bareCalls).toHaveLength(1)

    const repo = path.join(tmpDir, 'custom-common-dir-repo')
    mkdirSync(repo, { recursive: true })
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo })
    const registered = path.join(tmpDir, 'other-registered-project')
    const customCommonDir = path.join(tmpDir, 'custom-common-dir')
    mkdirSync(registered, { recursive: true })
    mkdirSync(customCommonDir, { recursive: true })
    await createProjectRegistry({ root: home }).add(realpathSync(registered))
    const customCalls: string[][] = []
    const nonstandardExec = async (_file: string, args: string[], options: { cwd: string; timeout: number }) => {
      customCalls.push(['git', ...args])
      return { stdout: `${repo}\n${customCommonDir}\n` }
    }
    await expect(findRegisteredProjectRoot(repo, { KB_HOME: home }, nonstandardExec)).resolves.toBeUndefined()
    expect(customCalls).toHaveLength(1)
  })

  it('ignores .kb and repository markers for project identity', async () => {
    const project = path.join(tmpDir, 'unregistered-marked-project')
    mkdirSync(path.join(project, '.kb'), { recursive: true })
    writeFileSync(path.join(project, '.kb', 'kb.config.json'), '{}')
    writeFileSync(path.join(project, 'package.json'), '{"name":"unregistered"}')

    await expect(resolveProjectRoot({ startDir: project, env: { KB_HOME: path.join(tmpDir, 'empty-home') } }))
      .rejects.toMatchObject({ envelope: { code: 'KB_PROJECT_UNKNOWN' } })
  })
})

describe('resolveWorkspaceRoot (deprecated alias)', () => {
  it('behaves identically to resolveProjectRoot', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'kb-alias-home-'))
    const project = mkdtempSync(path.join(os.tmpdir(), 'kb-alias-project-'))
    await createProjectRegistry({ root: home }).add(project)
    const options = { cwd: project, env: { KB_HOME: home } }
    const legacy = await resolveWorkspaceRoot(options)
    const current = await resolveProjectRoot(options)
    expect(legacy).toEqual(current)
    rmSync(home, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  })
})

describe('resolvePlatformRoot', () => {
  let tmpDir: string
  let originalCwd: string

  beforeAll(() => {
    originalCwd = process.cwd()
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'kb-platform-'))
  })

  afterEach(() => {
    process.chdir(tmpDir)
  })

  afterAll(() => {
    process.chdir(originalCwd)
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns explicit cwd when provided', async () => {
    const explicit = path.join(tmpDir, 'explicit')
    const result = await resolvePlatformRoot({ cwd: explicit })

    expect(result).toEqual({
      rootDir: path.resolve(explicit),
      source: 'explicit',
    })
  })

  it('prefers KB_PLATFORM_ROOT env var', async () => {
    const envRoot = path.join(tmpDir, 'env-platform')
    const result = await resolvePlatformRoot({
      env: { KB_PLATFORM_ROOT: envRoot },
    })

    expect(result).toEqual({
      rootDir: path.resolve(envRoot),
      source: 'env',
    })
  })

  // case: S-287.1
  it('resolves the development binary from its checkout declaration', async () => {
    const { checkout, moduleUrl } = createDeclaredLauncherCheckout()
    try {
      const result = await resolvePlatformRoot({ moduleUrl, env: {} })
      expect(result).toEqual({ rootDir: checkout, source: 'module' })
    } finally {
      rmSync(checkout, { recursive: true, force: true })
    }
  })

  it('resolves platform root via moduleUrl when node_modules/@kb-labs/cli-bin is present', async () => {
    // Simulate installed layout:
    //   <platformRoot>/node_modules/@kb-labs/cli-bin/dist/bin.js
    const platformRoot = path.join(tmpDir, 'installed-platform')
    const cliBinDist = path.join(
      platformRoot,
      'node_modules',
      '@kb-labs',
      'cli-bin',
      'dist',
    )
    mkdirSync(cliBinDist, { recursive: true })
    const fakeBin = path.join(cliBinDist, 'bin.js')
    writeFileSync(fakeBin, '// fake')

    const result = await resolvePlatformRoot({
      moduleUrl: pathToFileURL(fakeBin).href,
      startDir: tmpDir,
      env: {},
    })

    expect(result.rootDir).toEqual(path.resolve(platformRoot))
    expect(result.source).toBe('module')
  })

  it('does not infer platform ownership: walks up from startDir to find node_modules/@kb-labs/cli-bin', async () => {
    const platformRoot = path.join(tmpDir, 'marker-platform')
    const nested = path.join(platformRoot, 'some', 'deep', 'dir')
    mkdirSync(nested, { recursive: true })
    mkdirSync(
      path.join(platformRoot, 'node_modules', '@kb-labs', 'cli-bin'),
      { recursive: true },
    )

    await expect(resolvePlatformRoot({
      startDir: nested,
      env: {},
    })).rejects.toThrow()
  })

  it('does not infer platform ownership: walks up from startDir to find pnpm-workspace.yaml (dev mode)', async () => {
    const workspaceRoot = path.join(tmpDir, 'dev-workspace')
    const nested = path.join(workspaceRoot, 'packages', 'foo')
    mkdirSync(nested, { recursive: true })
    writeFileSync(path.join(workspaceRoot, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')

    await expect(resolvePlatformRoot({
      startDir: nested,
      env: {},
    })).rejects.toThrow()
  })

  it('uses launcher declaration above nested module markers', async () => {
    // Simulates a pnpm monorepo where an individual package has its own
    // node_modules/@kb-labs/cli-bin symlink (via hoisting). We want the
    // workspace root, not the first package that happens to have the marker.
    const workspaceRoot = path.join(tmpDir, 'dev-pnpm-ws')
    const nestedPackage = path.join(
      workspaceRoot,
      'platform',
      'kb-labs-cli',
      'packages',
      'cli-bin',
    )
    const cliBinDist = path.join(nestedPackage, 'dist')
    mkdirSync(cliBinDist, { recursive: true })
    const fakeBin = path.join(cliBinDist, 'bin.js')
    writeFileSync(fakeBin, '// fake')

    // Nested package hoisting symlink (pnpm-style)
    mkdirSync(
      path.join(nestedPackage, 'node_modules', '@kb-labs', 'cli-bin'),
      { recursive: true },
    )
    // Workspace marker at the top
    writeFileSync(
      path.join(workspaceRoot, 'pnpm-workspace.yaml'),
      'packages:\n  - platform/*/packages/*\n',
    )

    const result = await resolvePlatformRoot({
      moduleUrl: pathToFileURL(fakeBin).href,
      startDir: tmpDir,
      env: { KB_PLATFORM_ROOT: workspaceRoot },
    })

    // Must return the workspace root, not the nested package.
    expect(result.rootDir).toEqual(path.resolve(workspaceRoot))
    expect(result.source).toBe('env')
  })

  it('does not infer platform ownership: prefers top-most pnpm-workspace.yaml in nested-workspace layouts', async () => {
    // KB Labs "workspace of workspaces" pattern: each sub-repo has its own
    // pnpm-workspace.yaml, but the outermost one is the true monorepo root.
    const topLevelWorkspace = path.join(tmpDir, 'kb-nested-root')
    const subRepoWorkspace = path.join(topLevelWorkspace, 'platform', 'kb-labs-cli')
    const cliBin = path.join(subRepoWorkspace, 'packages', 'cli-bin')
    const cliBinDist = path.join(cliBin, 'dist')
    mkdirSync(cliBinDist, { recursive: true })
    const fakeBin = path.join(cliBinDist, 'bin.js')
    writeFileSync(fakeBin, '// fake')

    // Top-level workspace file
    writeFileSync(
      path.join(topLevelWorkspace, 'pnpm-workspace.yaml'),
      'packages:\n  - platform/*/packages/*\n',
    )
    // Nested (sub-repo) workspace file — must be ignored in favor of the top.
    writeFileSync(
      path.join(subRepoWorkspace, 'pnpm-workspace.yaml'),
      'packages:\n  - packages/*\n',
    )

    await expect(resolvePlatformRoot({
      moduleUrl: pathToFileURL(fakeBin).href,
      startDir: tmpDir,
      env: {},
    })).rejects.toThrow()
  })

  it('ignores platform markers inside a pnpm virtual store', async () => {
    // Reproduces the installed-mode bug where pnpm resolves an import through
    // its virtual store (`node_modules/.pnpm/<pkg>@<ver>_<hash>/node_modules/<pkg>/`)
    // and walk-up finds a `node_modules/@kb-labs/cli-bin` marker *inside* the
    // store. That marker must be skipped — the real platform root is the
    // directory that owns the hoisted symlinks at the outer `node_modules/`.
    const platformRoot = path.join(tmpDir, 'pnpm-installed-platform')
    // Real hoisted symlink target (the outer layer we want to find).
    mkdirSync(
      path.join(platformRoot, 'node_modules', '@kb-labs', 'cli-bin'),
      { recursive: true },
    )
    // Virtual store entry that bin.js is physically resolved through.
    const storeCliBinDist = path.join(
      platformRoot,
      'node_modules',
      '.pnpm',
      '@kb-labs+cli-bin@2.5.0_hash',
      'node_modules',
      '@kb-labs',
      'cli-bin',
      'dist',
    )
    mkdirSync(storeCliBinDist, { recursive: true })
    // Also create a fake nested `node_modules/@kb-labs/cli-bin` to prove the
    // walker would have stopped there without the fix.
    mkdirSync(
      path.join(
        platformRoot,
        'node_modules',
        '.pnpm',
        '@kb-labs+cli-bin@2.5.0_hash',
        'node_modules',
        '@kb-labs',
        'cli-bin',
        'node_modules',
        '@kb-labs',
        'cli-bin',
      ),
      { recursive: true },
    )
    const fakeBin = path.join(storeCliBinDist, 'bin.js')
    writeFileSync(fakeBin, '// fake')

    const result = await resolvePlatformRoot({
      moduleUrl: pathToFileURL(fakeBin).href,
      startDir: tmpDir,
      env: {},
    })

    // Must return the outer platform root, NOT any directory inside .pnpm.
    expect(result.rootDir).toEqual(path.resolve(platformRoot))
    expect(result.source).toBe('module')
  })

  it('does not infer platform ownership: falls back to repo root when no markers match', async () => {
    const repoRoot = path.join(tmpDir, 'platform-repo-fallback')
    const nested = path.join(repoRoot, 'deep')
    mkdirSync(nested, { recursive: true })
    writeFileSync(path.join(repoRoot, 'package.json'), '{"name":"x"}')

    await expect(resolvePlatformRoot({
      startDir: nested,
      env: {},
    })).rejects.toThrow()
  })
})

describe('resolveRoots', () => {
  let tmpDir: string
  let originalCwd: string

  beforeAll(() => {
    originalCwd = process.cwd()
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'kb-roots-'))
  })

  afterEach(() => {
    process.chdir(tmpDir)
  })

  afterAll(() => {
    process.chdir(originalCwd)
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('resolves platform roots without requiring a registered project', async () => {
    const platformRoot = path.join(tmpDir, 'platform-only-root')
    const cwd = path.join(tmpDir, 'unregistered-cwd')
    mkdirSync(cwd, { recursive: true })
    mkdirSync(path.join(platformRoot, 'node_modules', '@kb-labs', 'core-runtime'), { recursive: true })

    const result = await resolveRoots({
      startDir: cwd,
      env: { KB_PLATFORM_ROOT: platformRoot, KB_HOME: path.join(tmpDir, 'empty-home') },
      projectScope: 'platform',
    })

    expect(result).toEqual({
      platformRoot: path.resolve(platformRoot),
      projectRoot: undefined,
      sameLocation: false,
      projectStartDir: path.resolve(cwd),
      sources: { platform: 'env', projectStartDir: path.resolve(cwd) },
    })
  })

  it('resolves the registered project while keeping platform scope rooted at the platform', async () => {
    const platformRoot = path.join(tmpDir, 'platform-with-project')
    const projectRoot = path.join(tmpDir, 'registered-project')
    const home = path.join(tmpDir, 'platform-scope-home')
    mkdirSync(projectRoot, { recursive: true })
    mkdirSync(path.join(platformRoot, 'node_modules', '@kb-labs', 'core-runtime'), { recursive: true })
    await createProjectRegistry({ root: home }).add(projectRoot)

    const result = await resolveRoots({
      startDir: projectRoot,
      env: { KB_PLATFORM_ROOT: platformRoot, KB_HOME: home },
      projectScope: 'platform',
    })

    expect(result.platformRoot).toBe(path.resolve(platformRoot))
    expect(result.projectRoot).toBe(realpathSync(projectRoot))
    expect(result.sameLocation).toBe(false)
    expect(result.sources.project).toBe('registry')
  })

  it('returns sameLocation: true in dev-mode workspace (both resolve to same root)', async () => {
    const workspaceRoot = path.join(tmpDir, 'dev-mode-workspace')
    const nested = path.join(workspaceRoot, 'packages', 'foo')
    const configDir = path.join(workspaceRoot, '.kb')

    mkdirSync(nested, { recursive: true })
    mkdirSync(configDir, { recursive: true })
    writeFileSync(
      path.join(configDir, 'kb.config.json'),
      JSON.stringify({ platform: {} }),
    )
    writeFileSync(
      path.join(workspaceRoot, 'pnpm-workspace.yaml'),
      'packages:\n  - packages/*\n',
    )

    const home = path.join(tmpDir, 'dev-registry-home')
    await createProjectRegistry({ root: home }).add(workspaceRoot)
    const result = await resolveRoots({
      startDir: nested,
      env: { KB_HOME: home, KB_PLATFORM_ROOT: workspaceRoot },
    })

    expect(result.platformRoot).toEqual(path.resolve(workspaceRoot))
    expect(result.projectRoot).toEqual(realpathSync(workspaceRoot))
    expect(result.sameLocation).toBe(true)
    expect(result.sources.platform).toBe('env')
    expect(result.sources.project).toBe('registry')
  })

  it('returns sameLocation: false in installed mode', async () => {
    // Platform installation
    const platformRoot = path.join(tmpDir, 'installed-platform-2')
    const cliBinDist = path.join(
      platformRoot,
      'node_modules',
      '@kb-labs',
      'cli-bin',
      'dist',
    )
    mkdirSync(cliBinDist, { recursive: true })
    const fakeBin = path.join(cliBinDist, 'bin.js')
    writeFileSync(fakeBin, '// fake')

    // User project
    const projectRoot = path.join(tmpDir, 'user-project')
    mkdirSync(projectRoot, { recursive: true })
    const home = path.join(tmpDir, 'installed-registry-home')
    await createProjectRegistry({ root: home }).add(projectRoot)

    const result = await resolveRoots({
      moduleUrl: pathToFileURL(fakeBin).href,
      startDir: projectRoot,
      env: { KB_HOME: home },
    })

    expect(result.platformRoot).toEqual(path.resolve(platformRoot))
    expect(result.projectRoot).toEqual(realpathSync(projectRoot))
    expect(result.sameLocation).toBe(false)
    expect(result.sources.platform).toBe('module')
    expect(result.sources.project).toBe('registry')
  })

  it('platform env override does not replace registry project identity', async () => {
    const platformRoot = path.join(tmpDir, 'env-platform-root')
    const projectRoot = path.join(tmpDir, 'env-project-root')
    mkdirSync(projectRoot, { recursive: true })

    const home = path.join(tmpDir, 'roots-registry-home')
    await createProjectRegistry({ root: home }).add(projectRoot)
    const result = await resolveRoots({
      startDir: projectRoot,
      env: {
        KB_PLATFORM_ROOT: platformRoot,
        KB_HOME: home,
      },
    })

    expect(result.platformRoot).toEqual(path.resolve(platformRoot))
    expect(result.projectRoot).toEqual(realpathSync(projectRoot))
    expect(result.sameLocation).toBe(false)
    expect(result.sources.platform).toBe('env')
    expect(result.sources.project).toBe('registry')
  })
})

describe('platform launcher ownership', () => {
  // case: S-287.6
  it('resolves the development checkout from its repository launcher declaration', async () => {
    const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../')
    const launcherPath = path.join(checkout, 'cli/bin/dist/bin.js')
    const result = await resolvePlatformRoot({ moduleUrl: pathToFileURL(launcherPath).href, env: {} })

    expect(result).toEqual({ rootDir: checkout, source: 'module' })
  })

  // case: S-287.7
  it('surfaces the typed conversion error for a malformed launcher module URL', async () => {
    await expect(resolvePlatformRoot({ moduleUrl: 'not a URL', env: {} }))
      .rejects.toMatchObject({ code: 'ERR_INVALID_URL', name: 'TypeError' })
  })

  // case: S-287.6
  it('uses the pnpm kb binary declaration without a launcher env override', async () => {
    const { checkout, moduleUrl } = createDeclaredLauncherCheckout()
    try {
      const result = await resolvePlatformRoot({ moduleUrl, env: {} })
      expect(result).toEqual({ rootDir: checkout, source: 'module' })
    } finally {
      rmSync(checkout, { recursive: true, force: true })
    }
  })

  it('does not infer the platform from a project workspace when no launcher declares it', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'kb-platform-owner-'))
    try {
      const project = path.join(root, 'project')
      mkdirSync(project)
      writeFileSync(path.join(project, 'pnpm-workspace.yaml'), 'packages: []\n')
      await expect(resolvePlatformRoot({ startDir: project, env: {} })).rejects.toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
