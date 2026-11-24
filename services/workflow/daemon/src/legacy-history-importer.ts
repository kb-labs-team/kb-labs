import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { link, lstat, mkdir, open, realpath, readdir, unlink } from 'node:fs/promises'
import { dirname, join, parse, relative, sep } from 'node:path'
import {
  canonicalizeProjectPath,
  deriveProjectId,
  isProjectId,
  projectStateDir,
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
  workflowLegacyHistoryMigrationMarkerPath,
  workflowRunRecordPath,
} from '@kb-labs/workflow-engine'

const MIGRATION_VERSION = 1
const FILESYSTEM_ADAPTER = '@kb-labs/adapters-fs'

export interface LegacyHistoryImportResult {
  status: 'imported' | 'already-imported' | 'blocked' | 'retryable-failure'
  imported: number
  alreadyPresent: number
  skipped: number
  conflicts: number
  reason?: string
}

interface MigrationMarker {
  version: number
  projectId: string
  completedAt: string
  imported: number
  alreadyPresent: number
  skipped: number
  conflicts: number
}

/**
 * Returns the legacy storage root only when runtime evidence proves that the
 * daemon uses the built-in filesystem adapter's default project-state path.
 */
export async function trustedLegacyProjectStorageRoot(
  runtime: Pick<PlatformRuntime, 'platformConfig' | 'startupReport' | 'roots'>,
  projectId: string | undefined,
): Promise<string | null> {
  if (!projectId || !isProjectId(projectId) || runtime.startupReport.status !== 'ready') return null
  const projectRoot = runtime.roots.projectRoot
  if (!projectRoot) return null

  let canonicalProjectRoot: string
  try {
    canonicalProjectRoot = await canonicalizeProjectPath(projectRoot)
  } catch {
    return null
  }
  if (canonicalProjectRoot !== projectRoot || deriveProjectId(canonicalProjectRoot) !== projectId) return null

  const selected = configuredAdapterForSlot('storage', runtime.platformConfig.adapters ?? {})
  const configuredPath = typeof selected?.value === 'string'
    ? selected.value
    : Array.isArray(selected?.value) && typeof selected.value[0] === 'string'
      ? selected.value[0]
      : undefined
  if (configuredPath && adapterPackageRoot(configuredPath) !== FILESYSTEM_ADAPTER) return null

  const storageOptions = selected
    ? runtime.platformConfig.adapterOptions?.[selected.key]
    : undefined
  if (storageOptions && typeof storageOptions === 'object' && !Array.isArray(storageOptions)
      && Object.hasOwn(storageOptions, 'baseDir')) return null

  const actualStorage = runtime.startupReport.adapters.find((adapter) => adapter.slot === 'storage')
  if (actualStorage?.mode !== 'real' || adapterPackageRoot(actualStorage.implementation) !== FILESYSTEM_ADAPTER) {
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
 * The source is never deleted. A durable marker prevents a later startup from
 * restoring an imported record after its scoped copy was deliberately removed.
 */
export async function importLegacyWorkflowHistory(
  storageRoot: string,
  projectId: string,
): Promise<LegacyHistoryImportResult> {
  const counters = { imported: 0, alreadyPresent: 0, skipped: 0, conflicts: 0 }
  const markerRelative = workflowLegacyHistoryMigrationMarkerPath(projectId)
  const markerPath = join(storageRoot, ...markerRelative.split('/'))

  try {
    if (!await ensureAbsoluteDirectory(storageRoot)) return blocked(counters, 'unsafe-storage-root')
    if (!await ensureSafeDirectories(storageRoot, [])) return blocked(counters, 'unsafe-storage-root')
    const markerDirectory = dirname(markerRelative).split('/')
    if (!await ensureSafeDirectories(storageRoot, markerDirectory)) {
      return blocked(counters, 'unsafe-migration-directory')
    }
    const existingMarker = await readRegularFile(markerPath)
    if (existingMarker.status === 'unsafe') return blocked(counters, 'unsafe-migration-marker')
    if (existingMarker.status === 'read-error') return blocked(counters, 'unreadable-migration-marker')
    if (existingMarker.status === 'file') {
      const marker = parseMarker(existingMarker.bytes, projectId)
      return marker ? { status: 'already-imported', ...markerCounters(marker) } : blocked(counters, 'invalid-migration-marker')
    }

    const sourceDirectory = join(storageRoot, 'workflows')
    const sourceState = await directoryState(sourceDirectory)
    if (sourceState === 'symlink' || sourceState === 'not-directory' || sourceState === 'unreadable') {
      return blocked(counters, `unsafe-legacy-directory-${sourceState}`)
    }

    if (sourceState === 'directory') {
      const canonicalSource = await realpath(sourceDirectory)
      if (canonicalSource !== sourceDirectory) return blocked(counters, 'legacy-directory-alias')
      const entries = await readdir(sourceDirectory, { withFileTypes: true })
      const runDirectory = dirname(join(storageRoot, ...workflowRunRecordPath(projectId, 'valid-id').split('/')))
      const runDirectoryRelative = relative(storageRoot, runDirectory)
      if (!await ensureSafeDirectories(storageRoot, runDirectoryRelative.split(sep))) {
        return blocked(counters, 'unsafe-project-run-directory')
      }

      for (const entry of entries) {
        if (entry.isSymbolicLink() || !entry.isFile() || !entry.name.endsWith('.json')) {
          counters.skipped += 1
          continue
        }
        const runId = entry.name.slice(0, -'.json'.length)
        if (!isSafeWorkflowRunId(runId)) {
          counters.skipped += 1
          continue
        }

        const source = await readRegularFile(join(sourceDirectory, entry.name), true)
        if (source.status !== 'file') {
          if (source.status === 'read-error') return retryable(counters, 'legacy-record-read-failed')
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

        const destination = join(storageRoot, ...workflowRunRecordPath(projectId, runId).split('/'))
        const existing = await readRegularFile(destination)
        if (existing.status === 'read-error') return retryable(counters, 'scoped-record-read-failed')
        if (existing.status === 'unsafe') {
          counters.conflicts += 1
          continue
        }
        if (existing.status === 'file') {
          if (existing.bytes.equals(source.bytes)) counters.alreadyPresent += 1
          else counters.conflicts += 1
          continue
        }

        const written = await writeFileExclusive(destination, source.bytes)
        if (written === 'written') counters.imported += 1
        else if (written === 'exists-equal') counters.alreadyPresent += 1
        else if (written === 'exists-different') counters.conflicts += 1
        else return retryable(counters, 'scoped-record-write-failed')
      }
    }

    if (counters.conflicts > 0) {
      return blocked(counters, 'scoped-record-conflict')
    }

    const marker: MigrationMarker = {
      version: MIGRATION_VERSION,
      projectId,
      completedAt: new Date().toISOString(),
      ...counters,
    }
    const markerBytes = Buffer.from(JSON.stringify(marker), 'utf8')
    const markerWrite = await writeFileExclusive(markerPath, markerBytes)
    if (markerWrite === 'written' || markerWrite === 'exists-equal') {
      return { status: counters.conflicts > 0 ? 'blocked' : 'imported', ...counters,
        ...(counters.conflicts > 0 ? { reason: 'scoped-record-conflict' } : {}) }
    }
    if (markerWrite === 'exists-different') {
      const racedMarker = await readRegularFile(markerPath)
      const parsedMarker = racedMarker.status === 'file' ? parseMarker(racedMarker.bytes, projectId) : null
      return parsedMarker
        ? { status: 'already-imported', ...markerCounters(parsedMarker) }
        : blocked(counters, 'migration-marker-conflict')
    }
    return retryable(counters, 'migration-marker-write-failed')
  } catch {
    return retryable(counters, 'legacy-history-import-failed')
  }
}

type ReadResult =
  | { status: 'missing' }
  | { status: 'file'; bytes: Buffer }
  | { status: 'unsafe' }
  | { status: 'read-error' }

async function readRegularFile(path: string, rejectHardLinks = false): Promise<ReadResult> {
  let before: Awaited<ReturnType<typeof lstat>>
  try {
    before = await lstat(path)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { status: 'missing' }
      : { status: 'read-error' }
  }
  if (before.isSymbolicLink() || !before.isFile() || (rejectHardLinks && before.nlink !== 1)) {
    return { status: 'unsafe' }
  }

  let file: Awaited<ReturnType<typeof open>> | undefined
  try {
    const noFollow = constants.O_NOFOLLOW ?? 0
    file = await open(path, constants.O_RDONLY | noFollow)
    const opened = await file.stat()
    if (!opened.isFile() || (rejectHardLinks && opened.nlink !== 1) || opened.dev !== before.dev || opened.ino !== before.ino) {
      return { status: 'unsafe' }
    }
    return { status: 'file', bytes: await file.readFile() }
  } catch {
    return { status: 'read-error' }
  } finally {
    await file?.close().catch(() => undefined)
  }
}

type DirectoryState = 'missing' | 'directory' | 'symlink' | 'not-directory' | 'unreadable'

async function directoryState(path: string): Promise<DirectoryState> {
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink()) return 'symlink'
    return info.isDirectory() ? 'directory' : 'not-directory'
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable'
  }
}

async function ensureSafeDirectories(storageRoot: string, segments: string[]): Promise<boolean> {
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
    if (await directoryState(current) !== 'directory') return false
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
    if (await directoryState(current) !== 'directory') return false
  }
  return true
}

type ExclusiveWriteResult = 'written' | 'exists-equal' | 'exists-different' | 'failed'

async function writeFileExclusive(path: string, bytes: Buffer): Promise<ExclusiveWriteResult> {
  const directory = dirname(path)
  const temporary = join(directory, `.workflow-import-${process.pid}-${randomUUID()}.tmp`)
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
        return existing.bytes.equals(bytes) ? 'exists-equal' : 'exists-different'
      }
      return 'failed'
    }
    const directoryHandle = await open(directory, constants.O_RDONLY)
    await directoryHandle.sync().catch(() => undefined)
    await directoryHandle.close()
    return 'written'
  } catch {
    return 'failed'
  } finally {
    await file?.close().catch(() => undefined)
    await unlink(temporary).catch(() => undefined)
  }
}

function parseMarker(bytes: Buffer, projectId: string): MigrationMarker | null {
  try {
    const parsed: unknown = JSON.parse(bytes.toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const marker = parsed as Partial<MigrationMarker>
    return marker.version === MIGRATION_VERSION && marker.projectId === projectId &&
      typeof marker.completedAt === 'string' && Number.isInteger(marker.imported) &&
      Number.isInteger(marker.alreadyPresent) && Number.isInteger(marker.skipped) &&
      Number.isInteger(marker.conflicts)
      ? marker as MigrationMarker
      : null
  } catch {
    return null
  }
}

function markerCounters(marker: MigrationMarker): Omit<LegacyHistoryImportResult, 'status' | 'reason'> {
  return {
    imported: marker.imported,
    alreadyPresent: marker.alreadyPresent,
    skipped: marker.skipped,
    conflicts: marker.conflicts,
  }
}

function blocked(counters: Omit<LegacyHistoryImportResult, 'status' | 'reason'>, reason: string): LegacyHistoryImportResult {
  return { status: 'blocked', ...counters, reason }
}

function retryable(counters: Omit<LegacyHistoryImportResult, 'status' | 'reason'>, reason: string): LegacyHistoryImportResult {
  return { status: 'retryable-failure', ...counters, reason }
}
