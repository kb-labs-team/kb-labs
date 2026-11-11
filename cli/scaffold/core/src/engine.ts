import { join } from 'node:path';
import type {
  BlockDefinition,
  EntityDefinition,
  ManifestPatch,
  ManifestSnippets,
  RenderContext,
  RenderedFile,
} from '@kb-labs/scaffold-contracts';
import { resolveBlocks } from './resolver/resolve-blocks.js';
import {
  renderFilesDir,
  renderString,
} from './render/eta-renderer.js';
import {
  deepMerge,
  loadPatch,
  loadSnippets,
  mergeSnippets,
} from './patch/apply-patch.js';
import { emitManifest } from './emit/emit-manifest.js';

export interface BuildInputs {
  entity: EntityDefinition;
  selectedBlockIds: string[];
  context: RenderContext;
}

export interface BuildResult {
  blocks: BlockDefinition[];
  files: RenderedFile[];
  manifest: ManifestPatch;
  snippets: ManifestSnippets;
  outRoot: string;
}

/**
 * Compose the full render result from a resolved entity + user selections.
 *
 * Steps:
 *   1. Resolve & topo-sort blocks (expanding requires, checking conflicts).
 *   2. Render every block's `files/` directory into in-memory RenderedFile[].
 *   3. Fold manifest patches and snippets in topological order.
 *   4. Compute `outRoot` from `entity.output` (also eta-rendered).
 *
 * No disk writes happen here — call `writeFiles()` afterward.
 */
export async function build(inputs: BuildInputs): Promise<BuildResult> {
  const { entity, selectedBlockIds, context } = inputs;
  const renderContext = {
    ...context,
    pluginId: context.scope ? `${context.scope}/${context.name}` : context.name,
  };

  const resolved = resolveBlocks(entity.blocks, selectedBlockIds);

  const files: RenderedFile[] = [];
  let manifest: ManifestPatch = {};
  let snippets: ManifestSnippets = {};

  for (const block of resolved.blocks) {
    const blockFiles = await renderFilesDir(block.filesDir, renderContext);
    files.push(...blockFiles);

    if (block.manifestPatch) {
      const patch = await loadPatch(block.manifestPatch, renderContext);
      manifest = deepMerge(manifest, patch);
    }
    if (block.snippetsPath) {
      const s = await loadSnippets(block.snippetsPath, renderContext);
      snippets = mergeSnippets(snippets, s);
    }
  }

  const outTemplate = entity.output ?? join('.kb', 'plugins', '<%= it.name %>');
  const outRoot = renderString(outTemplate, renderContext);

  if (entity.manifestTarget) {
    const manifestTarget = renderString(entity.manifestTarget, renderContext);
    files.push({
      path: manifestTarget,
      contents: emitManifest(manifest, snippets),
    });
  }

  return { blocks: resolved.blocks, files, manifest, snippets, outRoot };
}
