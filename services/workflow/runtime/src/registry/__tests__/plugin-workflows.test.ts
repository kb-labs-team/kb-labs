import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { extractWorkflows, findWorkflow } from '../plugin-workflows'

// Minimal YAML workflow content for temp files
const MINIMAL_WORKFLOW_YAML = `name: test-workflow
version: '1.0.0'
on:
  manual: true
jobs:
  main:
    runsOn: local
    steps:
      - name: Step
        run: echo "hello"
`

function makeSnapshot(entries: Array<{
  pluginId: string
  pluginRoot: string
  manifest: Record<string, unknown>
}>) {
  return {
    manifests: entries.map(e => ({
      pluginId: e.pluginId,
      pluginRoot: e.pluginRoot,
      manifest: e.manifest,
    })),
  } as any
}

describe('extractWorkflows — plugin templates', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = join(tmpdir(), `plugin-workflows-test-${Date.now()}`)
    await mkdir(tempDir, { recursive: true })
    // package.json must exist so the directory-traversal finds packageRoot
    await writeFile(join(tempDir, 'package.json'), JSON.stringify({ name: '@test/plugin', version: '1.0.0' }))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  })

  it('returns empty array for empty snapshot', async () => {
    const result = await extractWorkflows(makeSnapshot([]))
    expect(result).toEqual([])
  })

  it('returns empty array for plugin with no workflows field', async () => {
    const result = await extractWorkflows(makeSnapshot([{
      pluginId: '@test/plugin',
      pluginRoot: tempDir,
      manifest: { schema: 'kb.plugin/3', id: '@test/plugin', version: '1.0.0' },
    }]))
    expect(result).toEqual([])
  })

  it('returns empty array for plugin with empty handlers and no templates', async () => {
    const result = await extractWorkflows(makeSnapshot([{
      pluginId: '@test/plugin',
      pluginRoot: tempDir,
      manifest: {
        schema: 'kb.plugin/3',
        id: '@test/plugin',
        version: '1.0.0',
        workflows: { handlers: [] },
      },
    }]))
    expect(result).toEqual([])
  })

  it('extracts templates from plugin manifest', async () => {
    await writeFile(join(tempDir, 'full-release.yaml'), MINIMAL_WORKFLOW_YAML)

    const result = await extractWorkflows(makeSnapshot([{
      pluginId: '@test/plugin',
      pluginRoot: tempDir,
      manifest: {
        schema: 'kb.plugin/3',
        id: '@test/plugin',
        version: '1.0.0',
        workflows: {
          handlers: [],
          templates: [
            {
              id: 'full-release',
              describe: 'Full release cycle',
              path: './full-release.yaml',
              tags: ['release'],
            },
          ],
        },
      },
    }]))

    expect(result).toHaveLength(1)
    expect(result[0]?.id).toBe('plugin:@test/plugin/full-release')
    expect(result[0]?.source).toBe('plugin')
    expect(result[0]?.description).toBe('Full release cycle')
    expect(result[0]?.tags).toEqual(['release'])
    expect(result[0]?.filePath).toContain('full-release.yaml')
    expect(result[0]?.metadata?.pluginId).toBe('@test/plugin')
    expect(result[0]?.metadata?.pluginVersion).toBe('1.0.0')
  })

  it('extracts multiple templates from one plugin', async () => {
    const result = await extractWorkflows(makeSnapshot([{
      pluginId: '@test/plugin',
      pluginRoot: tempDir,
      manifest: {
        schema: 'kb.plugin/3',
        id: '@test/plugin',
        version: '1.0.0',
        workflows: {
          handlers: [],
          templates: [
            { id: 'full-release', describe: 'Full', path: './full-release.yaml' },
            { id: 'hotfix',       describe: 'Hotfix', path: './hotfix.yaml' },
            { id: 'dry-run',      describe: 'Dry run', path: './dry-run.yaml' },
          ],
        },
      },
    }]))

    expect(result).toHaveLength(3)
    const ids = result.map(w => w.id)
    expect(ids).toContain('plugin:@test/plugin/full-release')
    expect(ids).toContain('plugin:@test/plugin/hotfix')
    expect(ids).toContain('plugin:@test/plugin/dry-run')
  })

  it('extracts both handlers and templates from same plugin', async () => {
    const result = await extractWorkflows(makeSnapshot([{
      pluginId: '@test/plugin',
      pluginRoot: tempDir,
      manifest: {
        schema: 'kb.plugin/3',
        id: '@test/plugin',
        version: '1.0.0',
        workflows: {
          handlers: [
            { id: 'my-activity', describe: 'An activity', handler: './dist/activity.js' },
          ],
          templates: [
            { id: 'my-template', describe: 'A template', path: './templates/my.yaml' },
          ],
        },
      },
    }]))

    expect(result).toHaveLength(2)
    const ids = result.map(w => w.id)
    expect(ids).toContain('plugin:@test/plugin/my-activity')
    expect(ids).toContain('plugin:@test/plugin/my-template')
  })

  it('aggregates templates from multiple plugins', async () => {
    const tempDir2 = join(tmpdir(), `plugin-workflows-test-2-${Date.now()}`)
    await mkdir(tempDir2, { recursive: true })
    await writeFile(join(tempDir2, 'package.json'), JSON.stringify({ name: '@test/plugin2', version: '2.0.0' }))

    try {
      const result = await extractWorkflows(makeSnapshot([
        {
          pluginId: '@test/plugin',
          pluginRoot: tempDir,
          manifest: {
            schema: 'kb.plugin/3',
            id: '@test/plugin',
            version: '1.0.0',
            workflows: {
              handlers: [],
              templates: [{ id: 'template-a', path: './a.yaml' }],
            },
          },
        },
        {
          pluginId: '@test/plugin2',
          pluginRoot: tempDir2,
          manifest: {
            schema: 'kb.plugin/3',
            id: '@test/plugin2',
            version: '2.0.0',
            workflows: {
              handlers: [],
              templates: [{ id: 'template-b', path: './b.yaml' }],
            },
          },
        },
      ]))

      expect(result).toHaveLength(2)
      const ids = result.map(w => w.id)
      expect(ids).toContain('plugin:@test/plugin/template-a')
      expect(ids).toContain('plugin:@test/plugin2/template-b')
    } finally {
      await rm(tempDir2, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('template without tags has undefined tags', async () => {
    const result = await extractWorkflows(makeSnapshot([{
      pluginId: '@test/plugin',
      pluginRoot: tempDir,
      manifest: {
        schema: 'kb.plugin/3',
        id: '@test/plugin',
        version: '1.0.0',
        workflows: {
          handlers: [],
          templates: [{ id: 'no-tags', path: './no-tags.yaml' }],
        },
      },
    }]))

    expect(result).toHaveLength(1)
    expect(result[0]?.tags).toBeUndefined()
    expect(result[0]?.description).toBeUndefined()
  })
})

describe('findWorkflow — plugin templates', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = join(tmpdir(), `find-workflow-test-${Date.now()}`)
    await mkdir(tempDir, { recursive: true })
    await writeFile(join(tempDir, 'package.json'), JSON.stringify({ name: '@kb-labs/release', version: '1.0.0' }))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  })

  const makeReleaseSnapshot = (dir: string) => makeSnapshot([{
    pluginId: '@kb-labs/release',
    pluginRoot: dir,
    manifest: {
      schema: 'kb.plugin/3',
      id: '@kb-labs/release',
      version: '1.0.0',
      workflows: {
        handlers: [],
        templates: [
          { id: 'full-release', describe: 'Full release', path: './workflows/templates/full-release.yaml' },
          { id: 'hotfix',       describe: 'Hotfix',       path: './workflows/templates/hotfix.yaml' },
        ],
      },
    },
  }])

  it('finds template by exact plugin: ID', async () => {
    const result = await findWorkflow(
      makeReleaseSnapshot(tempDir),
      'plugin:@kb-labs/release/full-release',
    )
    expect(result).not.toBeNull()
    expect(result?.id).toBe('plugin:@kb-labs/release/full-release')
    expect(result?.description).toBe('Full release')
  })

  it('finds template by short ID (without plugin: prefix)', async () => {
    const result = await findWorkflow(
      makeReleaseSnapshot(tempDir),
      '@kb-labs/release/full-release',
    )
    expect(result).not.toBeNull()
    expect(result?.id).toBe('plugin:@kb-labs/release/full-release')
  })

  it('returns null for unknown ID', async () => {
    const result = await findWorkflow(
      makeReleaseSnapshot(tempDir),
      'plugin:@kb-labs/release/nonexistent',
    )
    expect(result).toBeNull()
  })

  it('returns null for empty snapshot', async () => {
    const result = await findWorkflow(makeSnapshot([]), 'plugin:@kb-labs/release/full-release')
    expect(result).toBeNull()
  })
})
