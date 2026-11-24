import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
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

const FILESYSTEM_ADAPTER = '@kb-labs/adapters-fs'

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
    {return null}
  const projectRoot = runtime.roots.projectRoot
  if (!projectRoot) {return null}

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
    {return null}

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
    {return null}

  const storageOptions = selected
    ? runtime.platformConfig.adapterOptions?.[selected.key]
    : undefined
  if (
    storageOptions &&
    typeof storageOptions === 'object' &&
    !Array.isArray(storageOptions) &&
    Object.hasOwn(storageOptions, 'baseDir')
  )
    {return null}

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
