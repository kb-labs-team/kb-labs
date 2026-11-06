/**
 * Extract workflows from CLI API registry snapshot
 *
 * Uses the same pattern as REST API - no local discovery, just snapshot extraction.
 */

import { join, resolve, dirname } from 'node:path'
import { access } from 'node:fs/promises'
import type { RegistrySnapshot } from '@kb-labs/plugin-contracts'
import type { ManifestV3 } from '@kb-labs/plugin-contracts'
import type { ResolvedWorkflow } from './types'

interface SnapshotManifestEntry {
  pluginId: string
  manifest: ManifestV3
  pluginRoot: string
}

function extractSnapshotManifests(snapshot: RegistrySnapshot): SnapshotManifestEntry[] {
  return (snapshot.manifests || []).map(entry => ({
    pluginId: entry.pluginId,
    manifest: entry.manifest,
    pluginRoot: entry.pluginRoot,
  }))
}

/**
 * Extract workflows from registry snapshot
 *
 * @param snapshot - CLI API registry snapshot
 * @returns Array of resolved workflows from plugin manifests
 */
export async function extractWorkflows(snapshot: RegistrySnapshot): Promise<ResolvedWorkflow[]> {
  const manifests = extractSnapshotManifests(snapshot)
  const workflows: ResolvedWorkflow[] = []

  for (const entry of manifests) {
    const { manifest, pluginRoot } = entry

    // Skip plugins without any workflow contributions (handlers or templates)
    const workflowHandlers = manifest.workflows?.handlers ?? []
    const workflowTemplates = manifest.workflows?.templates ?? []
    if (workflowHandlers.length === 0 && workflowTemplates.length === 0) {
      continue
    }

    // Find package root by walking up from pluginRoot until we find package.json
    // This ensures we resolve workflows relative to the actual package root, not dist/
    // pluginRoot might be dist/ (where manifest is), but workflows are in package root
    let packageRoot = pluginRoot
    let currentDir = resolve(pluginRoot)

    // IMPORTANT: Directory traversal must be sequential (walking up parent directories)
    /* eslint-disable no-await-in-loop */
    while (currentDir !== dirname(currentDir)) {
      try {
        const pkgPath = join(currentDir, 'package.json')
        await access(pkgPath)
        packageRoot = currentDir
        break
      } catch {
        currentDir = dirname(currentDir)
      }
    }
    /* eslint-enable no-await-in-loop */

    for (const wfHandler of workflowHandlers) {
      const id = `plugin:${entry.pluginId}/${wfHandler.id}`

      // Resolve workflow handler file relative to package root
      // Handler files are included via package.json "files" field
      const filePath = resolve(packageRoot, wfHandler.handler)

      workflows.push({
        id,
        source: 'plugin',
        filePath,
        description: wfHandler.describe,
        tags: undefined, // V3 doesn't have tags on workflow handlers
        metadata: {
          pluginId: entry.pluginId,
          pluginVersion: manifest.version,
        },
      })
    }

    // Extract workflow templates (static YAML files bundled with plugin)
    for (const templateDecl of workflowTemplates) {
      const id = `plugin:${entry.pluginId}/${templateDecl.id}`
      const filePath = resolve(packageRoot, templateDecl.path)

      workflows.push({
        id,
        source: 'plugin',
        filePath,
        description: templateDecl.describe,
        tags: templateDecl.tags,
        metadata: {
          pluginId: entry.pluginId,
          pluginVersion: manifest.version,
        },
      })
    }
  }

  return workflows
}

/**
 * Find workflow by ID in registry snapshot
 *
 * @param snapshot - CLI API registry snapshot
 * @param id - Workflow ID (with or without "plugin:" prefix)
 * @returns Resolved workflow or null if not found
 */
export async function findWorkflow(
  snapshot: RegistrySnapshot,
  id: string,
): Promise<ResolvedWorkflow | null> {
  // Remove plugin: prefix if present
  const cleanId = id.startsWith('plugin:') ? id.slice('plugin:'.length) : id

  const workflows = await extractWorkflows(snapshot)
  return workflows.find((w) => w.id === id || w.id.endsWith(':' + cleanId)) ?? null
}
