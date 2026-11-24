import { link, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  importLegacyWorkflowHistory,
} from '../legacy-history-importer.js'
import {
  workflowLegacyHistoryMigrationMarkerPath,
  workflowRunRecordPath,
} from '@kb-labs/workflow-engine'

const projectId = 'prj_0000000000000001'
const roots: string[] = []

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kb-workflow-import-')))
  roots.push(root)
  await mkdir(join(root, 'workflows'))
  return root
}

function run(id: string) {
  return {
    id,
    tenantId: 'default',
    name: 'legacy',
    version: '1.0.0',
    status: 'success',
    eventSequence: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    queuedAt: '2026-01-01T00:00:00.000Z',
    trigger: { type: 'manual' },
    jobs: [],
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('legacy workflow history import', () => {
  it('copies valid source bytes once and does not resurrect a later deletion', async () => {
    const root = await fixture()
    const raw = Buffer.from(JSON.stringify(run('legacy-1')))
    await writeFile(join(root, 'workflows', 'legacy-1.json'), raw)

    await expect(importLegacyWorkflowHistory(root, projectId)).resolves.toMatchObject({
      status: 'imported', imported: 1,
    })
    const destination = join(root, ...workflowRunRecordPath(projectId, 'legacy-1').split('/'))
    await expect(readFile(destination)).resolves.toEqual(raw)
    await rm(destination)

    await expect(importLegacyWorkflowHistory(root, projectId)).resolves.toMatchObject({
      status: 'already-imported', imported: 1,
    })
    await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(root, ...workflowLegacyHistoryMigrationMarkerPath(projectId).split('/')))).resolves.toBeTruthy()
  })

  it('keeps a conflicting scoped record and the legacy source untouched', async () => {
    const root = await fixture()
    const source = Buffer.from(JSON.stringify(run('same-id')))
    const destination = join(root, ...workflowRunRecordPath(projectId, 'same-id').split('/'))
    await mkdir(join(destination, '..'), { recursive: true })
    await writeFile(join(root, 'workflows', 'same-id.json'), source)
    await writeFile(destination, Buffer.from('owned scoped record'))

    await expect(importLegacyWorkflowHistory(root, projectId)).resolves.toMatchObject({
      status: 'blocked', conflicts: 1,
    })
    await expect(readFile(destination, 'utf8')).resolves.toBe('owned scoped record')
    await expect(readFile(join(root, 'workflows', 'same-id.json'))).resolves.toEqual(source)
  })

  it('fails closed on a symlinked legacy directory', async () => {
    const root = await fixture()
    await rm(join(root, 'workflows'), { recursive: true })
    await symlink(tmpdir(), join(root, 'workflows'))
    await expect(importLegacyWorkflowHistory(root, projectId)).resolves.toMatchObject({ status: 'blocked' })
  })

  it('skips symlinked and hard-linked legacy records', async () => {
    const root = await fixture()
    const symlinkTarget = join(root, 'symlink-target.json')
    const hardlinkTarget = join(root, 'hardlink-target.json')
    await writeFile(symlinkTarget, JSON.stringify(run('symlink-run')))
    await writeFile(hardlinkTarget, JSON.stringify(run('hardlink-run')))
    await symlink(symlinkTarget, join(root, 'workflows', 'symlink-run.json'))
    await link(hardlinkTarget, join(root, 'workflows', 'hardlink-run.json'))

    await expect(importLegacyWorkflowHistory(root, projectId)).resolves.toMatchObject({
      status: 'imported', imported: 0, skipped: 2,
    })
    await expect(readFile(symlinkTarget, 'utf8')).resolves.toBe(JSON.stringify(run('symlink-run')))
    await expect(readFile(hardlinkTarget, 'utf8')).resolves.toBe(JSON.stringify(run('hardlink-run')))
    for (const id of ['symlink-run', 'hardlink-run']) {
      await expect(readFile(join(root, ...workflowRunRecordPath(projectId, id).split('/'))))
        .rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  it('skips malformed legacy records without assigning them to the project', async () => {
    const root = await fixture()
    await writeFile(join(root, 'workflows', 'invalid.json'), '{broken')
    await expect(importLegacyWorkflowHistory(root, projectId)).resolves.toMatchObject({
      status: 'imported', imported: 0, skipped: 1,
    })
    await expect(readFile(join(root, 'workflows', 'invalid.json'), 'utf8')).resolves.toBe('{broken')
  })
})
