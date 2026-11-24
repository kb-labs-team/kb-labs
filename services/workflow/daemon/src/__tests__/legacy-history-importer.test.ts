import {
  link,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { importLegacyWorkflowHistory } from '../legacy-history-importer.js'
import {
  workflowLegacyHistoryMigrationDecisionPath,
  workflowRunRecordPath,
} from '@kb-labs/workflow-engine'

const projectId = 'prj_0000000000000001'
const roots: string[] = []

async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'kb-workflow-import-')),
  )
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
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('legacy workflow history import', () => {
  it('imports rollback-era runs and does not resurrect a deleted imported run', async () => {
    const root = await fixture()
    const firstRaw = Buffer.from(JSON.stringify(run('legacy-1')))
    await writeFile(join(root, 'workflows', 'legacy-1.json'), firstRaw)

    await expect(
      importLegacyWorkflowHistory(root, projectId),
    ).resolves.toMatchObject({
      status: 'imported',
      imported: 1,
    })
    const destination = join(
      root,
      ...workflowRunRecordPath(projectId, 'legacy-1').split('/'),
    )
    await expect(readFile(destination)).resolves.toEqual(firstRaw)
    await rm(destination)

    await expect(
      importLegacyWorkflowHistory(root, projectId),
    ).resolves.toMatchObject({
      status: 'already-imported',
      imported: 0,
      skipped: 1,
    })
    await expect(readFile(destination)).rejects.toMatchObject({
      code: 'ENOENT',
    })

    const rollbackRaw = Buffer.from(JSON.stringify(run('rollback-run')))
    await writeFile(join(root, 'workflows', 'rollback-run.json'), rollbackRaw)
    await expect(
      importLegacyWorkflowHistory(root, projectId),
    ).resolves.toMatchObject({
      status: 'imported',
      imported: 1,
      skipped: 1,
    })
    await expect(
      readFile(
        join(
          root,
          ...workflowRunRecordPath(projectId, 'rollback-run').split('/'),
        ),
      ),
    ).resolves.toEqual(rollbackRaw)
    for (const id of ['legacy-1', 'rollback-run']) {
      await expect(
        readFile(
          join(
            root,
            ...workflowLegacyHistoryMigrationDecisionPath(projectId, id).split(
              '/',
            ),
          ),
        ),
      ).resolves.toBeTruthy()
    }
  })

  it('keeps a conflicting scoped record and the legacy source untouched', async () => {
    const root = await fixture()
    const source = Buffer.from(JSON.stringify(run('same-id')))
    const destination = join(
      root,
      ...workflowRunRecordPath(projectId, 'same-id').split('/'),
    )
    await mkdir(join(destination, '..'), { recursive: true })
    await writeFile(join(root, 'workflows', 'same-id.json'), source)
    await writeFile(destination, Buffer.from('owned scoped record'))

    await expect(
      importLegacyWorkflowHistory(root, projectId),
    ).resolves.toMatchObject({
      status: 'conflict',
      conflicts: 1,
    })
    await expect(readFile(destination, 'utf8')).resolves.toBe(
      'owned scoped record',
    )
    await expect(
      readFile(join(root, 'workflows', 'same-id.json')),
    ).resolves.toEqual(source)
  })

  it('serializes concurrent startup imports and records each run once', async () => {
    const root = await fixture()
    const raw = Buffer.from(JSON.stringify(run('concurrent-run')))
    await writeFile(join(root, 'workflows', 'concurrent-run.json'), raw)

    const results = await Promise.all([
      importLegacyWorkflowHistory(root, projectId),
      importLegacyWorkflowHistory(root, projectId),
    ])

    expect(results.filter((result) => result.imported === 1)).toHaveLength(1)
    expect(results.filter((result) => result.skipped === 1)).toHaveLength(1)
    await expect(
      readFile(
        join(
          root,
          ...workflowRunRecordPath(projectId, 'concurrent-run').split('/'),
        ),
      ),
    ).resolves.toEqual(raw)
  })

  it('fails closed for a changed legacy record after a decision without overwriting scoped history', async () => {
    const root = await fixture()
    const sourcePath = join(root, 'workflows', 'changed-run.json')
    const original = Buffer.from(JSON.stringify(run('changed-run')))
    await writeFile(sourcePath, original)
    await expect(
      importLegacyWorkflowHistory(root, projectId),
    ).resolves.toMatchObject({ status: 'imported' })

    const changed = Buffer.from(
      JSON.stringify({ ...run('changed-run'), status: 'failed' }),
    )
    await writeFile(sourcePath, changed)
    await expect(
      importLegacyWorkflowHistory(root, projectId),
    ).resolves.toMatchObject({
      status: 'conflict',
      conflicts: 1,
    })
    await expect(
      readFile(
        join(
          root,
          ...workflowRunRecordPath(projectId, 'changed-run').split('/'),
        ),
      ),
    ).resolves.toEqual(original)
  })

  it('skips a corrupt per-run decision while importing other valid rollback-era runs', async () => {
    const root = await fixture()
    const decisions = join(
      root,
      ...workflowLegacyHistoryMigrationDecisionPath(
        projectId,
        'corrupt-run',
      ).split('/'),
    )
    await mkdir(join(decisions, '..'), { recursive: true })
    await writeFile(decisions, '{corrupt')
    await writeFile(
      join(root, 'workflows', 'corrupt-run.json'),
      JSON.stringify(run('corrupt-run')),
    )
    const validBytes = Buffer.from(JSON.stringify(run('recoverable-run')))
    await writeFile(join(root, 'workflows', 'recoverable-run.json'), validBytes)

    await expect(
      importLegacyWorkflowHistory(root, projectId),
    ).resolves.toMatchObject({
      status: 'conflict',
      imported: 1,
      conflicts: 1,
    })
    await expect(
      readFile(
        join(
          root,
          ...workflowRunRecordPath(projectId, 'corrupt-run').split('/'),
        ),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      readFile(
        join(
          root,
          ...workflowRunRecordPath(projectId, 'recoverable-run').split('/'),
        ),
      ),
    ).resolves.toEqual(validBytes)
  })

  it('fails closed on a symlinked legacy directory', async () => {
    const root = await fixture()
    await rm(join(root, 'workflows'), { recursive: true })
    await symlink(tmpdir(), join(root, 'workflows'))
    await expect(
      importLegacyWorkflowHistory(root, projectId),
    ).resolves.toMatchObject({ status: 'blocked' })
  })

  it('skips symlinked and hard-linked legacy records', async () => {
    const root = await fixture()
    const symlinkTarget = join(root, 'symlink-target.json')
    const hardlinkTarget = join(root, 'hardlink-target.json')
    await writeFile(symlinkTarget, JSON.stringify(run('symlink-run')))
    await writeFile(hardlinkTarget, JSON.stringify(run('hardlink-run')))
    await symlink(symlinkTarget, join(root, 'workflows', 'symlink-run.json'))
    await link(hardlinkTarget, join(root, 'workflows', 'hardlink-run.json'))

    await expect(
      importLegacyWorkflowHistory(root, projectId),
    ).resolves.toMatchObject({
      status: 'imported',
      imported: 0,
      skipped: 2,
    })
    await expect(readFile(symlinkTarget, 'utf8')).resolves.toBe(
      JSON.stringify(run('symlink-run')),
    )
    await expect(readFile(hardlinkTarget, 'utf8')).resolves.toBe(
      JSON.stringify(run('hardlink-run')),
    )
    for (const id of ['symlink-run', 'hardlink-run']) {
      await expect(
        readFile(
          join(root, ...workflowRunRecordPath(projectId, id).split('/')),
        ),
      ).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  it('skips malformed legacy records without assigning them to the project', async () => {
    const root = await fixture()
    await writeFile(join(root, 'workflows', 'invalid.json'), '{broken')
    await expect(
      importLegacyWorkflowHistory(root, projectId),
    ).resolves.toMatchObject({
      status: 'imported',
      imported: 0,
      skipped: 1,
    })
    await expect(
      readFile(join(root, 'workflows', 'invalid.json'), 'utf8'),
    ).resolves.toBe('{broken')
  })
})
