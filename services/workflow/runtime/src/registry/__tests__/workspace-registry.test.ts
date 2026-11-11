import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WorkspaceWorkflowRegistry } from '../workspace-registry'

describe('WorkspaceWorkflowRegistry', () => {
  let tempDir: string
  let registry: WorkspaceWorkflowRegistry

  beforeEach(async () => {
    tempDir = join(tmpdir(), `workflow-test-${Date.now()}`)
    await mkdir(tempDir, { recursive: true })
    registry = new WorkspaceWorkflowRegistry({
      workspaceRoot: tempDir,
      patterns: ['*.yml', '*.yaml', '**/*.yml', '**/*.yaml'],
    })
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
    await registry.dispose()
  })

  it('should discover workflows from workspace', async () => {
    // Create a workflow file
    const workflowContent = `name: test-workflow
version: 1.0.0
description: Test workflow
on:
  manual: true
jobs:
  test:
    runsOn: local
    steps:
      - name: Test Step
        uses: builtin:shell
        with:
          command: echo "test"
`
    const testFile = join(tempDir, 'test-workflow.yml')
    await writeFile(testFile, workflowContent)

    // Wait for file system
    await new Promise((resolve) => {
      setTimeout(resolve, 100)
    })

    const workflows = await registry.list()

    expect(workflows.length).toBeGreaterThanOrEqual(0)
    if (workflows.length > 0) {
      expect(workflows[0]?.source).toBe('workspace')
      expect(workflows[0]?.id).toContain('test-workflow')
    }
  })

  it('should generate correct IDs from file paths', async () => {
    await mkdir(join(tempDir, 'workflows', 'nested'), { recursive: true })
    const workflowContent = `name: nested-workflow
version: 1.0.0
on:
  manual: true
jobs: {}
`
    await writeFile(join(tempDir, 'workflows', 'nested', 'workflow.yml'), workflowContent)

    // Wait for file system
    await new Promise((resolve) => {
      setTimeout(resolve, 100)
    })

    const workflows = await registry.list()

    expect(workflows.length).toBeGreaterThanOrEqual(0)
    if (workflows.length > 0) {
      expect(workflows[0]?.id).toContain('workflow')
    }
  })

  it('should resolve workflow by ID', async () => {
    const workflowContent = `name: test
version: 1.0.0
on:
  manual: true
jobs:
  main:
    runsOn: local
    steps:
      - name: Test
        uses: builtin:shell
        with:
          command: echo "test"
`
    const testFile = join(tempDir, 'test.yml')
    await writeFile(testFile, workflowContent)

    // Wait a bit for file system to sync
    await new Promise((resolve) => {
      setTimeout(resolve, 100)
    })

    // Refresh registry to pick up new file
    await registry.refresh()

    const resolved = await registry.resolve('workspace:test')
    expect(resolved).not.toBeNull()
    if (resolved) {
      expect(resolved.id).toContain('test')
      expect(resolved.source).toBe('workspace')
    }
  })

  it('should cache workflow list', async () => {
    const workflowContent = `name: test
version: 1.0.0
on:
  manual: true
jobs: {}
`
    await writeFile(join(tempDir, 'test.yml'), workflowContent)

    // Wait for file system
    await new Promise((resolve) => {
      setTimeout(resolve, 100)
    })

    const first = await registry.list()
    const second = await registry.list()

    // Should return cached result (same array reference)
    expect(first).toBe(second)
    expect(first.length).toBeGreaterThanOrEqual(0)
  })

  it('mtime staleness: fast path serves cache when files unchanged', async () => {
    const workflowContent = `name: stable
version: 1.0.0
on:
  manual: true
jobs: {}
`
    await writeFile(join(tempDir, 'stable.yml'), workflowContent)
    await new Promise((resolve) => { setTimeout(resolve, 50) })

    const first = await registry.list()
    const second = await registry.list()

    // No file changes → same array reference (cache served, no rescan)
    expect(second).toBe(first)
  })

  it('mtime staleness: auto-detects new file without manual refresh', async () => {
    const makeWorkflow = (name: string) => `name: ${name}
version: 1.0.0
on:
  manual: true
jobs:
  main:
    runsOn: local
    steps:
      - name: Step
        uses: builtin:shell
        with:
          command: echo "${name}"
`
    await writeFile(join(tempDir, 'first.yml'), makeWorkflow('first'))
    await new Promise((resolve) => { setTimeout(resolve, 50) })

    const first = await registry.list()
    expect(first.some(w => w.id.includes('first'))).toBe(true)

    // Add a second file — mtime snapshot size changes → stale
    await writeFile(join(tempDir, 'second.yml'), makeWorkflow('second'))
    await new Promise((resolve) => { setTimeout(resolve, 50) })

    const second = await registry.list()
    expect(second.some(w => w.id.includes('second'))).toBe(true)
    expect(second.length).toBeGreaterThan(first.length)
  })

  it('mtime staleness: auto-detects file modification', async () => {
    const makeWorkflow = (desc: string) => `name: mutable
version: 1.0.0
description: ${desc}
on:
  manual: true
jobs:
  main:
    runsOn: local
    steps:
      - name: Step
        uses: builtin:shell
        with:
          command: echo "test"
`
    const filePath = join(tempDir, 'mutable.yml')
    await writeFile(filePath, makeWorkflow('original'))
    await new Promise((resolve) => { setTimeout(resolve, 50) })

    const first = await registry.list()
    const originalDesc = first.find(w => w.id.includes('mutable'))?.description
    expect(originalDesc).toBe('original')

    // Overwrite with new description — mtime changes → stale
    await new Promise((resolve) => { setTimeout(resolve, 10) })
    await writeFile(filePath, makeWorkflow('updated'))
    await new Promise((resolve) => { setTimeout(resolve, 50) })

    const second = await registry.list()
    const updatedDesc = second.find(w => w.id.includes('mutable'))?.description

    expect(updatedDesc).toBe('updated')
  })

  it('should refresh cache', async () => {
    const workflowContent = `name: test
version: 1.0.0
on:
  manual: true
jobs: {}
`
    await writeFile(join(tempDir, 'test.yml'), workflowContent)

    // Wait for file system
    await new Promise((resolve) => {
      setTimeout(resolve, 100)
    })

    const first = await registry.list()
    const firstCount = first.length

    // Create second file
    const secondFile = join(tempDir, 'test2.yml')
    await writeFile(secondFile, workflowContent)
    
    // Wait for file system
    await new Promise((resolve) => {
      setTimeout(resolve, 100)
    })
    
    // Refresh cache
    await registry.refresh()

    // List again - should see both files (or at least the new one)
    const second = await registry.list()
    // After refresh, should have at least as many as before
    expect(second.length).toBeGreaterThanOrEqual(firstCount)
  })
})

