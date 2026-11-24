import { constants, type Dirent } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  readdir,
  unlink,
} from 'node:fs/promises'
import { dirname, join, parse } from 'node:path'
import {
  canonicalizeProjectPath,
  deriveProjectId,
  isProjectId,
  projectStateDir,
  withFileLock,
} from '@kb-labs/core-project-registry'
import { resolveKbHome } from '@kb-labs/core-platform'
import {
  adapterPackageRoot,
  configuredAdapterForSlot,
  type PlatformRuntime,
} from '@kb-labs/core-runtime'
import { RunSchema } from '@kb-labs/workflow-contracts'
import {
  isSafeWorkflowRunId,
  workflowLegacyHistoryMigrationDecisionPath,
  workflowRunRecordPath,
} from '@kb-labs/workflow-engine'

const MIGRATION_VERSION = 1
const FILESYSTEM_ADAPTER = '@kb-labs/adapters-fs'

export interface LegacyHistoryImportResult {
  status:
    | 'imported'
    | 'already-imported'
    | 'conflict'
    | 'blocked'
    | 'retryable-failure'
  imported: number
  alreadyPresent: number
  alreadyDecided: number
  skipped: number
  conflicts: number
  reason?: string
}

interface MigrationDecision {
  version: number
  projectId: string
  runId: string
  sourceSha256: string
}

/**
 * Returns the legacy storage root only when runtime evidence proves that the
 * daemon uses the built-in filesystem adapter's default project-state path.
 */
export async function trustedLegacyProjectStorageRoot(
  runtime: Pick<PlatformRuntime, 'platformConfig' | 'startupReport' | 'roots'>,
  projectId: string | undefined,
): Promise<string | null> {
  if (
    !projectId ||
    !isProjectId(projectId) ||
    runtime.startupReport.status !== 'ready'
  )
    return null
  const projectRoot = runtime.roots.projectRoot
  if (!projectRoot) return null

  let canonicalProjectRoot: string
  try {
    canonicalProjectRoot = await canonicalizeProjectPath(projectRoot)
  } catch {
    return null
  }
  if (
    canonicalProjectRoot !== projectRoot ||
    deriveProjectId(canonicalProjectRoot) !== projectId
  )
    return null

  const selected = configuredAdapterForSlot(
    'storage',
    runtime.platformConfig.adapters ?? {},
  )
  const configuredPath =
    typeof selected?.value === 'string'
      ? selected.value
      : Array.isArray(selected?.value) && typeof selected.value[0] === 'string'
        ? selected.value[0]
        : undefined
  if (
    configuredPath &&
    adapterPackageRoot(configuredPath) !== FILESYSTEM_ADAPTER
  )
    return null

  const storageOptions = selected
    ? runtime.platformConfig.adapterOptions?.[selected.key]
    : undefined
  if (
    storageOptions &&
    typeof storageOptions === 'object' &&
    !Array.isArray(storageOptions) &&
    Object.hasOwn(storageOptions, 'baseDir')
  )
    return null

  const actualStorage = runtime.startupReport.adapters.find(
    (adapter) => adapter.slot === 'storage',
  )
  if (
    actualStorage?.mode !== 'real' ||
    adapterPackageRoot(actualStorage.implementation) !== FILESYSTEM_ADAPTER
  ) {
    return null
  }

  let platformStateRoot: string
  try {
    platformStateRoot = await realpath(resolveKbHome())
  } catch {
    return null
  }
  return join(projectStateDir(platformStateRoot, projectId), 'storage')
}

/**
 * Copy validated daemon records from the proven project-private legacy path.
 * Per-run decisions allow later legacy runs to be imported after rollback,
 * without restoring a run whose scoped copy was deliberately removed.
 */
export async function importLegacyWorkflowHistory(
  storageRoot: string,
  projectId: string,
): Promise<LegacyHistoryImportResult> {
  const counters = {
    imported: 0,
    alreadyPresent: 0,
    alreadyDecided: 0,
    skipped: 0,
    conflicts: 0,
  }
  try {
    if (!(await ensureAbsoluteDirectory(storageRoot)))
      return blocked(counters, 'unsafe-storage-root')
    if (!(await ensureSafeDirectories(storageRoot, [])))
      return blocked(counters, 'unsafe-storage-root')
    const decisionDirectoryRelative = dirname(
      workflowLegacyHistoryMigrationDecisionPath(projectId, 'valid-id'),
    )
    if (
      !(await ensureSafeDirectories(
        storageRoot,
        decisionDirectoryRelative.split('/'),
      ))
    ) {
      return blocked(counters, 'unsafe-migration-directory')
    }
    const lockPath = join(
      storageRoot,
      ...decisionDirectoryRelative.split('/'),
      '.import.lock',
    )
    return await withFileLock(
      lockPath,
      async () => {
        const sourceDirectory = join(storageRoot, 'workflows')
        const runDirectory = join(
          storageRoot,
          ...workflowRunRecordPath(projectId, 'valid-id').split('/').slice(0, -1),
        )
        if (
          !(await ensureSafeDirectories(
            storageRoot,
            workflowRunRecordPath(projectId, 'valid-id').split('/').slice(0, -1),
          ))
        ) {
          return blocked(counters, 'unsafe-project-run-directory')
        }
        const decisionDirectory = join(storageRoot, ...decisionDirectoryRelative.split('/'))
        await cleanupImporterTemporaryFiles(runDirectory)
        await cleanupImporterTemporaryFiles(decisionDirectory)
        if (!(await validateScopedRunDirectory(runDirectory))) {
          return blocked(counters, 'unsafe-project-run-record')
        }
        const sourceState = await directoryState(sourceDirectory)
        if (
          sourceState === 'symlink' ||
          sourceState === 'not-directory' ||
          sourceState === 'unreadable'
        ) {
          return conflict(counters, `unsafe-legacy-directory-${sourceState}`)
        }

        if (sourceState === 'directory') {
          let canonicalSource: string
          let entries: Dirent[]
          try {
            canonicalSource = await realpath(sourceDirectory)
            entries = await readdir(sourceDirectory, { withFileTypes: true })
          } catch {
            return conflict(counters, 'unreadable-legacy-directory')
          }
          if (canonicalSource !== sourceDirectory)
            return conflict(counters, 'legacy-directory-alias')
          for (const entry of entries) {
            if (
              entry.isSymbolicLink() ||
              !entry.isFile() ||
              !entry.name.endsWith('.json')
            ) {
              counters.skipped += 1
              continue
            }
            const runId = entry.name.slice(0, -'.json'.length)
            if (!isSafeWorkflowRunId(runId)) {
              counters.skipped += 1
              continue
            }

            const source = await readRegularFile(
              join(sourceDirectory, entry.name),
              true,
            )
            if (source.status !== 'file') {
              if (source.status === 'read-error')
                counters.conflicts += 1
              counters.skipped += 1
              continue
            }
            let parsed: unknown
            try {
              parsed = JSON.parse(source.bytes.toString('utf8'))
            } catch {
              counters.skipped += 1
              continue
            }
            const valid = RunSchema.safeParse(parsed)
            if (!valid.success || valid.data.id !== runId) {
              counters.skipped += 1
              continue
            }

            const decisionPath = join(
              storageRoot,
              ...workflowLegacyHistoryMigrationDecisionPath(
                projectId,
                runId,
              ).split('/'),
            )
            const priorDecision = await readRegularFile(decisionPath)
            if (priorDecision.status === 'unsafe') {
              return blocked(counters, 'unsafe-migration-decision')
            }
            if (priorDecision.status === 'read-error')
              return retryable(counters, 'unreadable-migration-decision')
            if (priorDecision.status === 'file') {
              const decision = parseDecision(
                priorDecision.bytes,
                projectId,
                runId,
              )
              if (
                !decision ||
                decision.sourceSha256 !==
                  createHash('sha256').update(source.bytes).digest('hex')
              ) {
                counters.conflicts += 1
                continue
              }
              counters.alreadyDecided += 1
              continue
            }

            const destination = join(
              storageRoot,
              ...workflowRunRecordPath(projectId, runId).split('/'),
            )
            const existing = await readRegularFile(destination)
            if (existing.status === 'read-error')
              return retryable(counters, 'scoped-record-read-failed')
            if (existing.status === 'unsafe') {
              return blocked(counters, 'unsafe-scoped-run-record')
            }
            let disposition: 'imported' | 'alreadyPresent'
            if (existing.status === 'file') {
              if (existing.bytes.equals(source.bytes)) {
                disposition = 'alreadyPresent'
                await syncDirectory(dirname(destination))
              } else {
                counters.conflicts += 1
                continue
              }
            } else {
              const written = await writeFileExclusive(
                destination,
                source.bytes,
              )
              if (written === 'written') disposition = 'imported'
              else if (written === 'exists-equal')
                disposition = 'alreadyPresent'
              else if (written === 'exists-different') {
                counters.conflicts += 1
                continue
              } else return retryable(counters, 'scoped-record-write-failed')
            }

            const decision: MigrationDecision = {
              version: MIGRATION_VERSION,
              projectId,
              runId,
              sourceSha256: createHash('sha256')
                .update(source.bytes)
                .digest('hex'),
            }
            const decisionWrite = await writeFileExclusive(
              decisionPath,
              Buffer.from(JSON.stringify(decision)),
            )
            if (decisionWrite === 'written' || decisionWrite === 'exists-equal')
              counters[disposition] += 1
            else if (decisionWrite === 'exists-different') {
              const racedDecision = await readRegularFile(decisionPath)
              if (
                racedDecision.status !== 'file' ||
                !parseDecision(racedDecision.bytes, projectId, runId)
              ) {
                return retryable(counters, 'migration-decision-conflict')
              }
              counters.alreadyPresent += 1
            } else return retryable(counters, 'migration-decision-write-failed')
          }
        }

        if (counters.conflicts > 0) {
          return conflict(counters, 'scoped-record-conflict')
        }
        return {
          status:
            counters.imported > 0
              ? 'imported'
              : counters.alreadyPresent > 0 || counters.alreadyDecided > 0
                ? 'already-imported'
                : 'imported',
          ...counters,
        }
      },
      { preserveLiveOwner: true },
    )
  } catch {
    return retryable(counters, 'legacy-history-import-failed')
  }
}

type ReadResult =
  | { status: 'missing' }
  | { status: 'file'; bytes: Buffer }
  | { status: 'unsafe' }
  | { status: 'read-error' }

async function readRegularFile(
  path: string,
  rejectHardLinks = false,
): Promise<ReadResult> {
  let before: Awaited<ReturnType<typeof lstat>>
  try {
    before = await lstat(path)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { status: 'missing' }
      : { status: 'read-error' }
  }
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    (rejectHardLinks && before.nlink !== 1)
  ) {
    return { status: 'unsafe' }
  }

  let file: Awaited<ReturnType<typeof open>> | undefined
  try {
    const noFollow = constants.O_NOFOLLOW ?? 0
    file = await open(path, constants.O_RDONLY | noFollow)
    const opened = await file.stat()
    if (
      !opened.isFile() ||
      (rejectHardLinks && opened.nlink !== 1) ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      return { status: 'unsafe' }
    }
    return { status: 'file', bytes: await file.readFile() }
  } catch {
    return { status: 'read-error' }
  } finally {
    await file?.close().catch(() => undefined)
  }
}

type DirectoryState =
  | 'missing'
  | 'directory'
  | 'symlink'
  | 'not-directory'
  | 'unreadable'

async function directoryState(path: string): Promise<DirectoryState> {
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink()) return 'symlink'
    return info.isDirectory() ? 'directory' : 'not-directory'
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'missing'
      : 'unreadable'
  }
}

async function ensureSafeDirectories(
  storageRoot: string,
  segments: string[],
): Promise<boolean> {
  const rootInfo = await directoryState(storageRoot)
  if (rootInfo !== 'directory') return false
  let current = storageRoot
  for (const segment of segments.filter(Boolean)) {
    current = join(current, segment)
    const state = await directoryState(current)
    if (state === 'missing') {
      try {
        await mkdir(current, { mode: 0o700 })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return false
      }
    } else if (state !== 'directory') {
      return false
    }
    if ((await directoryState(current)) !== 'directory') return false
  }
  return true
}

async function cleanupImporterTemporaryFiles(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!/^\.workflow-import-\d+-[a-f0-9-]+\.tmp$/.test(entry.name) || !entry.isFile()) {
      continue
    }
    const path = join(directory, entry.name)
    const file = await lstat(path)
    if (file.isFile() && !file.isSymbolicLink()) await unlink(path)
  }
}

async function validateScopedRunDirectory(directory: string): Promise<boolean> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.name.endsWith('.json')) continue
    const runId = entry.name.slice(0, -'.json'.length)
    if (!isSafeWorkflowRunId(runId)) continue
    if (entry.isSymbolicLink() || !entry.isFile()) return false
    const record = await readRegularFile(join(directory, entry.name), true)
    if (record.status !== 'file') return false
  }
  return true
}

async function ensureAbsoluteDirectory(path: string): Promise<boolean> {
  const absolute = join(path)
  const pathRoot = parse(absolute).root
  let current = pathRoot
  const segments = absolute.slice(pathRoot.length).split(sep).filter(Boolean)
  for (const segment of segments) {
    current = join(current, segment)
    const state = await directoryState(current)
    if (state === 'missing') {
      try {
        await mkdir(current, { mode: 0o700 })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return false
      }
    } else if (state !== 'directory') {
      return false
    }
    if ((await directoryState(current)) !== 'directory') return false
  }
  return true
}

type ExclusiveWriteResult =
  | 'written'
  | 'exists-equal'
  | 'exists-different'
  | 'failed'

async function writeFileExclusive(
  path: string,
  bytes: Buffer,
): Promise<ExclusiveWriteResult> {
  const directory = dirname(path)
  const temporary = join(
    directory,
    `.workflow-import-${process.pid}-${randomUUID()}.tmp`,
  )
  let file: Awaited<ReturnType<typeof open>> | undefined
  try {
    file = await open(temporary, 'wx', 0o600)
    await file.writeFile(bytes)
    await file.sync()
    await file.close()
    file = undefined
    try {
      await link(temporary, path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return 'failed'
      const existing = await readRegularFile(path)
      if (existing.status === 'file') {
        return existing.bytes.equals(bytes)
          ? 'exists-equal'
          : 'exists-different'
      }
      return 'failed'
    }
    await syncDirectory(directory)
    return 'written'
  } catch {
    return 'failed'
  } finally {
    await file?.close().catch(() => undefined)
    await unlink(temporary).catch(() => undefined)
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const directoryHandle = await open(directory, constants.O_RDONLY)
  try {
    await directoryHandle.sync()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EBADF'].includes(code ?? '')) throw error
  } finally {
    await directoryHandle.close()
  }
}

function parseDecision(
  bytes: Buffer,
  projectId: string,
  runId: string,
): MigrationDecision | null {
  try {
    const parsed: unknown = JSON.parse(bytes.toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return null
    const decision = parsed as Partial<MigrationDecision>
    return decision.version === MIGRATION_VERSION &&
      decision.projectId === projectId &&
      decision.runId === runId &&
      typeof decision.sourceSha256 === 'string' &&
      /^[a-f0-9]{64}$/.test(decision.sourceSha256)
      ? (decision as MigrationDecision)
      : null
  } catch {
    return null
  }
}

function blocked(
  counters: Omit<LegacyHistoryImportResult, 'status' | 'reason'>,
  reason: string,
): LegacyHistoryImportResult {
  return { status: 'blocked', ...counters, reason }
}

function conflict(
  counters: Omit<LegacyHistoryImportResult, 'status' | 'reason'>,
  reason: string,
): LegacyHistoryImportResult {
  return { status: 'conflict', ...counters, reason }
}

function retryable(
  counters: Omit<LegacyHistoryImportResult, 'status' | 'reason'>,
  reason: string,
): LegacyHistoryImportResult {
  return { status: 'retryable-failure', ...counters, reason }
}
