import { test, expect } from '@playwright/test'
import { setUserConfigValue, unsetUserConfigValue, resolveUserConfigFile, parseJsonc } from '../../../../../core/config/dist/index.js'
import { loadCatalogAdapterEntries, resolvePlatformVersion, platform } from '../../../../../core/runtime/dist/index.js'
import { openCatalog } from '../../../../../core/registry/dist/index.js'
import { createErrorEnvelope } from '../../../../../core/platform/dist/index.js'
import { MarketplaceService } from '../../../../../services/marketplace/core/dist/index.js'
import { NpmPackageSource } from '../../../../../services/marketplace/npm/dist/index.js'
import { createExtensionStore } from '../../../../../core/extension-store/dist/index.js'

const { createHash } = process.getBuiltinModule('node:crypto')
const { execFile } = process.getBuiltinModule('node:child_process')
const { promisify } = process.getBuiltinModule('node:util')
const { fileURLToPath } = process.getBuiltinModule('node:url')
const path = process.getBuiltinModule('node:path')
const os = process.getBuiltinModule('node:os')
const fs = process.getBuiltinModule('node:fs').promises
const { createServer } = process.getBuiltinModule('node:http')
const runFile = promisify(execFile)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../')
const adapterPackage = '@kb-labs/adapters-vibeproxy'
const adapterVersion = '2.120.1'
const model = 'gpt-6-luna'

test('VibeProxy install, projected config, and host adapter loading @S-292.1 @S-293.1 @S-293.2 @S-293.3', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-vibeproxy-seam-'))
  const packDir = path.join(tempRoot, 'pack')
  const platformRoot = path.join(tempRoot, 'versions', 'v1')
  const stateRoot = path.join(tempRoot, 'state')
  await fs.mkdir(packDir, { recursive: true })
  await fs.mkdir(path.join(platformRoot, '.kb'), { recursive: true })
  await fs.mkdir(stateRoot, { recursive: true })
  await fs.mkdir(path.join(tempRoot, 'node_modules', '@kb-labs'), { recursive: true })
  await fs.symlink(path.join(repoRoot, 'sdk/sdk'), path.join(tempRoot, 'node_modules', '@kb-labs', 'sdk'))
  await fs.symlink(path.join('versions', 'v1'), path.join(tempRoot, 'current'))

  const layout = JSON.parse(await fs.readFile(path.join(repoRoot, 'tools/kb-create/v2/contracts/platform-layout.json'), 'utf8'))
  const configProjection = layout.sharedRuntimePaths.find(({ platformPath: projected }) => projected === '.kb/kb.config.jsonc')
  expect(configProjection).toBeDefined()
  await fs.writeFile(path.join(stateRoot, 'kb.config.jsonc'), '{}\n')
  await fs.symlink(
    path.relative(path.join(platformRoot, '.kb'), path.join(tempRoot, configProjection.statePath)),
    path.join(platformRoot, configProjection.platformPath),
  )
  await fs.writeFile(path.join(platformRoot, 'package.json'), JSON.stringify({ name: 'installed-platform', private: true }))
  await fs.writeFile(path.join(platformRoot, 'pnpm-workspace.yaml'), 'packages: []\n')

  let tarball
  let packageJson
  try {
    await runFile('pnpm', ['pack', '--pack-destination', packDir], {
      cwd: path.join(repoRoot, 'adapters/vibeproxy'),
      env: process.env,
    })
    const packedName = (await fs.readdir(packDir)).find((file) => file.endsWith('.tgz'))
    expect(packedName).toBeDefined()
    const tarballPath = path.join(packDir, packedName)
    tarball = await fs.readFile(tarballPath)
    const unpacked = await runFile('tar', ['-xOf', tarballPath, 'package/package.json'])
    packageJson = JSON.parse(unpacked.stdout)
  } catch (error) {
    await fs.rm(tempRoot, { recursive: true, force: true })
    throw error
  }

  const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`
  const registry = createServer((request, response) => {
    if (request.url === '/adapter.tgz') {
      response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(tarball)
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      name: packageJson.name,
      'dist-tags': { latest: packageJson.version },
      versions: {
        [packageJson.version]: {
          name: packageJson.name,
          version: packageJson.version,
          kb: packageJson.kb,
          dist: { integrity, tarball: `http://127.0.0.1:${registry.address().port}/adapter.tgz` },
        },
      },
    }))
  })
  registry.listen(0, '127.0.0.1')
  await new Promise((resolve) => registry.once('listening', resolve))

  let llmServer
  let catalog
  try {
    const registryUrl = `http://127.0.0.1:${registry.address().port}`
    const service = new MarketplaceService({
      platformRoot,
      logger: platform.logger,
      extensionStore: createExtensionStore({ platformRoot }),
      sources: [new NpmPackageSource({ registryUrl })],
      resolveSelectedAdapterSlot: async () => null,
    })
    const installed = await service.install({ scope: 'platform' }, [adapterPackage])
    expect(installed.installed[0]).toMatchObject({ id: adapterPackage, version: adapterVersion, source: 'npm' })

    const lock = JSON.parse(await fs.readFile(path.join(platformRoot, '.kb/marketplace.lock'), 'utf8'))
    expect(lock.adapters[adapterPackage]).toMatchObject({
      version: adapterVersion,
      integrity,
      source: 'marketplace',
      marketplaceSource: 'npm',
    })

    const configPath = await resolveUserConfigFile(platformRoot)
    const selected = await setUserConfigValue({ filePath: configPath, path: ['platform', 'adapters', 'llm'], value: adapterPackage })
    await setUserConfigValue({ filePath: configPath, path: ['platform', 'adapterOptions', 'llm', 'baseURL'], value: 'http://127.0.0.1:1' })
    await setUserConfigValue({ filePath: configPath, path: ['platform', 'adapterOptions', 'llm', 'model'], value: model })
    expect(await fs.realpath(selected.filePath)).toBe(await fs.realpath(path.join(stateRoot, 'kb.config.jsonc')))

    let requestedModel
    llmServer = createServer(async (request, response) => {
      const chunks = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      requestedModel = JSON.parse(Buffer.concat(chunks).toString('utf8')).model
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        id: 'msg-seam', type: 'message', role: 'assistant', model,
        content: [{ type: 'text', text: 'seam response' }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 2 },
      }))
    })
    llmServer.listen(0, '127.0.0.1')
    await new Promise((resolve) => llmServer.once('listening', resolve))
    const endpoint = `http://127.0.0.1:${llmServer.address().port}`
    await setUserConfigValue({ filePath: configPath, path: ['platform', 'adapterOptions', 'llm', 'baseURL'], value: endpoint })

    const config = parseJsonc(await fs.readFile(configPath, 'utf8'))
    const adapterConfig = config.platform.adapterOptions.llm
    const selectedAdapter = config.platform.adapters.llm
    catalog = await openCatalog({ platformRoot, projectRoot: platformRoot }, {
      resolvePlatformVersion: () => resolvePlatformVersion(platformRoot, {
        sameLocation: true,
        rawConfig: { platform: { mode: 'installed' } },
      }),
    })
    const catalogEntry = catalog.adapters().get(selectedAdapter)
    expect(catalogEntry).toMatchObject({ manifest: { kind: 'adapter' } })
    const discovered = await loadCatalogAdapterEntries(catalog.adapters(), { development: false, configuredPackages: [] })
    expect([...discovered.keys()]).toContain(selectedAdapter)
    const adapter = discovered.get(selectedAdapter)
    const adapterManifestModule = await import(path.join(adapter.pkgRoot, 'dist/manifest.js'))
    const modelOptionKey = adapterManifestModule.VIBEPROXY_MODEL_CONFIG_KEY
    expect(adapter.module.manifest.configSchema.model).toMatchObject({ required: true })
    expect(adapter.module.manifest.configSchema.model).not.toHaveProperty('default')
    const llm = adapter.createAdapter(adapterConfig)
    const result = await llm.complete('Say hello')
    expect(result.content).toBe('seam response')
    expect(requestedModel).toBe(model)

    await unsetUserConfigValue({ filePath: configPath, path: ['platform', 'adapterOptions', 'llm', 'model'] })
    const configWithoutModel = parseJsonc(await fs.readFile(configPath, 'utf8'))
    let missingModelError
    try {
      adapter.createAdapter(configWithoutModel.platform.adapterOptions.llm)
    } catch (error) {
      missingModelError = error
    }
    const modelOptionPath = `platform.adapterOptions.llm.${modelOptionKey}`
    expect(missingModelError).toMatchObject(createErrorEnvelope('KB_ADAPTER_CONFIG_REQUIRED', {
      details: {
        path: modelOptionPath,
        nextCommand: ['kb', 'config', 'set', '--scope', 'platform', modelOptionPath, '<model>'].join(' '),
      },
      cause: 'Required adapter option is missing.',
    }))
  } finally {
    if (catalog) await catalog.dispose()
    if (llmServer?.listening) await new Promise((resolve, reject) => llmServer.close((error) => error ? reject(error) : resolve()))
    if (registry.listening) await new Promise((resolve, reject) => registry.close((error) => error ? reject(error) : resolve()))
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
})
