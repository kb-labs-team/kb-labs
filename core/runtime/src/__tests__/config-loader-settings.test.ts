import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createProjectRegistry } from '@kb-labs/core-project-registry'
import { writeTestPlatformReceipt } from './platform-version-fixture.js'

const discoveryResult = vi.hoisted(() => ({
  plugins: [] as Array<{
    id: string;
    version: string;
    packageRoot: string;
    packageName: string;
    scope: 'platform';
    origin: 'node_modules';
    manifestPath: string;
    manifestKind: 'static';
    source: { kind: 'marketplace'; path: string };
    provides: [];
  }>,
  manifests: new Map<string, { id: string; configSection?: string; settings?: { schema: Record<string, unknown>; defaults?: Record<string, unknown> } }>(),
  failures: [] as unknown[],
  diagnostics: [] as unknown[],
  observations: [] as unknown[],
  requestIdentity: 'runtime-plugin-settings-test',
  fingerprint: 'runtime-plugin-settings-test',
}))

vi.mock('@kb-labs/core-discovery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kb-labs/core-discovery')>()
  return {
    ...actual,
    DiagnosticCollector: class { info() {} error() {} },
    DiscoveryManager: class {
      requestIdentity = 'runtime-plugin-settings-test'
      async discover() { return discoveryResult }
      async getMarketplaceLocks() { return new Map() }
    },
    resolveMarketplaceLockScope: async () => 'platform',
    readMarketplaceLock: async () => null,
  }
})

import { loadPlatformConfig } from '../config-loader.js'

describe('loadPlatformConfig project plugin settings', () => {
  let temporaryRoot: string | undefined

  afterEach(() => {
    if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true })
    temporaryRoot = undefined
    discoveryResult.plugins = []
    discoveryResult.manifests = new Map()
  })

  it('merges manifest defaults, platform values, then project values for runtime useConfig', async () => {
    temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'kb-runtime-plugin-settings-'))
    const platformRoot = path.join(temporaryRoot, 'platform')
    const projectRoot = path.join(temporaryRoot, 'project')
    const packageRoot = path.join(platformRoot, 'node_modules', '@kb-labs', 'sample')
    const home = path.join(temporaryRoot, 'home')
    mkdirSync(projectRoot, { recursive: true })
    mkdirSync(path.join(platformRoot, 'node_modules', '@kb-labs', 'cli-bin'), { recursive: true })
    writeTestPlatformReceipt(platformRoot)
    mkdirSync(path.join(platformRoot, '.kb'), { recursive: true })
    mkdirSync(packageRoot, { recursive: true })
    const env = { KB_PLATFORM_ROOT: platformRoot, KB_PROJECT_ROOT: projectRoot, KB_HOME: home }
    const project = await createProjectRegistry({ env }).add(realpathSync(projectRoot))
    const projectId = project.project.id
    mkdirSync(path.join(home, 'state', projectId), { recursive: true })
    writeFileSync(path.join(platformRoot, '.kb', 'kb.config.json'), JSON.stringify({
      plugins: { sample: { enabled: false, scope: { scopes: [{ id: 'platform' }] } } },
    }))
    writeFileSync(path.join(home, 'state', projectId, 'config.jsonc'), JSON.stringify({
      plugins: { sample: { scope: { scopes: [{ id: 'project' }] } } },
    }))
    discoveryResult.plugins = [{
      id: 'sample',
      version: '1.0.0',
      packageRoot,
      packageName: '@kb-labs/sample',
      scope: 'platform',
      origin: 'node_modules',
      manifestPath: path.join(packageRoot, 'manifest.json'),
      manifestKind: 'static',
      source: { kind: 'marketplace', path: packageRoot },
      provides: [],
    }]
    discoveryResult.manifests = new Map([['sample', {
      id: 'sample',
      configSection: 'sample',
      settings: {
        schema: { type: 'object', properties: { enabled: { type: 'boolean' }, scope: { type: 'object' } } },
        defaults: { enabled: true, scope: { scopes: [{ id: 'default' }] } },
      },
    }]])

    const result = await loadPlatformConfig({
      startDir: projectRoot,
      env,
      projectId,
      loadEnvFile: false,
    })

    expect(result.effectiveConfig?.plugins).toEqual({
      sample: { enabled: false, scope: { scopes: [{ id: 'project' }] } },
    })
    expect(result.pluginSettingsDefaults).toEqual([{
      pluginId: 'sample',
      configSection: 'sample',
      manifestPath: path.join(packageRoot, 'manifest.json'),
      data: { enabled: true, scope: { scopes: [{ id: 'default' }] } },
    }])
  })
})
