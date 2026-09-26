/**
 * @module @kb-labs/core-config/api/effective-config
 *
 * Canonical "give me the effective raw config" entry point.
 *
 * Assembles the configuration layers any KB Labs project may have
 * and returns the deep-merged result plus diagnostics about how it was
 * resolved (ADR-0047: generated < platform user < project user < overlays):
 *
 *   0. `<root>/.kb/generated/*.json|jsonc`  — installer-written GENERATED
 *      config (platform root first, then project root). Lowest precedence;
 *      absent in installs that do not generate config yet.
 *   1. `<platformRoot>/.kb/kb.config.*`  — platform baseline (installed
 *      mode only; absent in solo dev where projectRoot == platformRoot)
 *   2. `<projectRoot>/.kb/kb.config.*`   — project layer
 *   3. `<projectRoot>/.kb/overlays/*.jsonc`  — scenario overlays applied
 *      by `kb-dev ensure --scenario`, lex-sorted
 *
 * Each layer is deep-merged onto the previous via `mergeOverlay`. Overlays
 * are intentionally *project-only* — overlay files placed under the
 * platform root are ignored. Plugins that read their own section from the
 * raw config (gateway.*, mind.*, workflow.*, ...) should use this rather
 * than re-implementing the layering.
 *
 * Returns `null` only when none of the three layers contributed anything.
 *
 * This is complementary to `@kb-labs/core-runtime :: loadPlatformConfig`,
 * which produces the structured `PlatformConfig` view (adapters, core,
 * execution). Use `loadEffectiveConfig` when you need the full raw shape;
 * use `loadPlatformConfig` when you need platform initialisation.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { readJsonWithDiagnostics, mergeDefined } from '../runtime/runtime.js';
import type { Diagnostic } from '../types/index.js';
import { loadOverlays } from '../overlay/loader.js';
import { mergeOverlay } from '../overlay/merge.js';
import {
  buildProvenance,
  loadGeneratedLayer,
  type ConfigLayerFile,
  type ValueProvenance,
} from '../user-config/layers.js';

// Order matters: each entry is deep-merged onto the previous one within the
// same root, so the LAST file found wins on conflicts. Convention:
//
//   1. `kb.config.jsonc`         (root, human-edited template)
//   2. `kb.config.json`          (root, machine-written)
//   3. `.kb/kb.config.jsonc`     (preferred location, human-edited)
//   4. `.kb/kb.config.json`      (preferred location, machine-written — wins)
//
// In installed mode `kb-create` writes both `.kb/kb.config.jsonc` (full
// template snapshot) and `.kb/kb.config.json` (scan-updated authoritative
// snapshot). Reading only one of them would silently shadow the other —
// reading both, with `.json` last, lets the scan-derived values override
// the static template, which matches kb-create's intent.
const CONFIG_CANDIDATES = [
  'kb.config.jsonc',
  'kb.config.json',
  path.join('.kb', 'kb.config.jsonc'),
  path.join('.kb', 'kb.config.json'),
] as const;

export interface EffectiveConfigResult {
  /** Deep-merged effective data (platform ← project ← overlays). */
  data: Record<string, unknown>;
  /**
   * Absolute paths of platform-root config files actually loaded, in merge
   * order. Empty when no platform config file was found (or when
   * `platformRoot` was not provided / equals `projectRoot`).
   */
  platformConfigPaths: string[];
  /** Absolute paths of project-root config files actually loaded, in merge order. */
  projectConfigPaths: string[];
  /**
   * Deprecated single-path alias for the LAST platform config file applied.
   * Prefer `platformConfigPaths`. Kept for callers that only need to know
   * "did we load any platform config?".
   */
  platformConfigPath?: string;
  /**
   * Deprecated single-path alias for the LAST project config file applied.
   * Prefer `projectConfigPaths`.
   */
  projectConfigPath?: string;
  /** Absolute paths of overlays applied, in merge order. */
  overlayPaths: string[];
  /** Absolute paths of generated-layer files applied, in merge order. */
  generatedConfigPaths: string[];
  /** Every file that contributed, lowest precedence first. */
  layers: ConfigLayerFile[];
  /**
   * Which layer/file supplied each leaf of `data`, keyed by dotted path
   * (arrays are leaves; see `ValueProvenance.contributors`).
   */
  provenance: Record<string, ValueProvenance>;
  /** Non-fatal diagnostics (malformed files, layer rejected, etc). */
  diagnostics: Diagnostic[];
}

export interface LoadEffectiveConfigOptions {
  /**
   * Optional platform installation root. When provided and distinct from
   * `projectRoot`, its `kb.config.*` is read first and used as the
   * deep-merge baseline. Overlays are *not* read from this root.
   */
  platformRoot?: string;
}

async function findAllConfigsInRoot(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const rel of CONFIG_CANDIDATES) {
    const full = path.join(root, rel);
    try {
      await fsp.access(full);
      found.push(full);
    } catch {
      // missing — skip
    }
  }
  return found;
}

/**
 * Read every config file present at `root`, deep-merging them in
 * CONFIG_CANDIDATES order (later wins). Each file is parsed independently;
 * a malformed or non-object file emits a diagnostic but does not abort the
 * read of the remaining files at this root.
 *
 * Returns the list of paths actually loaded plus the merged data.
 */
async function readObjectsAtRoot(
  root: string,
  diagnostics: Diagnostic[],
  layer: 'platform' | 'project',
): Promise<{ paths: string[]; data: Record<string, unknown>; files: ConfigLayerFile[] }> {
  const paths = await findAllConfigsInRoot(root);
  let merged: Record<string, unknown> = {};
  const loaded: string[] = [];
  const files: ConfigLayerFile[] = [];

  for (const configPath of paths) {
    const read = await readJsonWithDiagnostics<unknown>(configPath);
    diagnostics.push(...read.diagnostics);
    // Past this point we record `configPath` as loaded — the file existed,
    // even if its content was unusable. Callers rely on `paths` to
    // distinguish "layer absent" from "layer present but degraded".
    loaded.push(configPath);
    if (!read.ok) {
      continue;
    }
    const data = read.data;
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      diagnostics.push({
        level: 'error',
        code: 'CONFIG_NOT_OBJECT',
        message: `Config must be a JSON object at top level: ${configPath}`,
      });
      continue;
    }
    // Within a single root we layer files (e.g. .jsonc template + .json
    // scan-update) using `mergeDefined` — the SAME semantics
    // `loadPlatformConfig` uses for its platform↔project merge. Arrays
    // concatenate at this layer; overlay-style array REPLACEMENT is
    // reserved for the explicit overlay step below and the `kb:merge`
    // directive within overlays.
    merged = mergeDefined(merged, data as Record<string, unknown>);
    files.push({ layer, path: configPath, data: data as Record<string, unknown> });
  }

  return { paths: loaded, data: merged, files };
}

/**
 * Load the effective project config — deep-merged across platform → project
 * → project overlays. Returns `null` when nothing contributed.
 */
export async function loadEffectiveConfig(
  projectRoot: string,
  options: LoadEffectiveConfigOptions = {},
): Promise<EffectiveConfigResult | null> {
  const diagnostics: Diagnostic[] = [];

  const usePlatform =
    !!options.platformRoot && options.platformRoot !== projectRoot;

  const generatedRoots = usePlatform ? [options.platformRoot!, projectRoot] : [projectRoot];
  const generatedLayer = await loadGeneratedLayer(generatedRoots);
  diagnostics.push(...generatedLayer.diagnostics);

  const platformLayer = usePlatform
    ? await readObjectsAtRoot(options.platformRoot!, diagnostics, 'platform')
    : { paths: [] as string[], data: {} as Record<string, unknown>, files: [] as ConfigLayerFile[] };
  const projectLayer = await readObjectsAtRoot(projectRoot, diagnostics, 'project');

  const overlayResult = await loadOverlays(projectRoot);
  diagnostics.push(...overlayResult.diagnostics);

  const nothingFound =
    generatedLayer.files.length === 0 &&
    platformLayer.paths.length === 0 &&
    projectLayer.paths.length === 0 &&
    overlayResult.overlays.length === 0;
  if (nothingFound) {
    return null;
  }

  // Platform ← project: SAME semantics as loadPlatformConfig — `mergeDefined`
  // (arrays concatenate). Keeps both APIs returning the same shape for the
  // shared two-layer step.
  // The generated layer is the baseline under both user layers.
  let merged: Record<string, unknown> = mergeDefined(
    mergeDefined(generatedLayer.data, platformLayer.data),
    projectLayer.data,
  );
  // Overlays: REPLACE semantics for arrays (with opt-in `kb:merge: append`)
  // — overlays are the explicit override layer, not a deep-merge layer.
  const overlayPaths: string[] = [];
  const overlayFiles: ConfigLayerFile[] = [];
  for (const overlay of overlayResult.overlays) {
    merged = mergeOverlay(merged, overlay.data);
    overlayPaths.push(overlay.path);
    overlayFiles.push({ layer: 'overlay', path: overlay.path, data: overlay.data });
  }

  const layers: ConfigLayerFile[] = [
    ...generatedLayer.files,
    ...platformLayer.files,
    ...projectLayer.files,
    ...overlayFiles,
  ];

  return {
    data: merged,
    platformConfigPaths: platformLayer.paths,
    projectConfigPaths: projectLayer.paths,
    platformConfigPath:
      platformLayer.paths[platformLayer.paths.length - 1],
    projectConfigPath: projectLayer.paths[projectLayer.paths.length - 1],
    overlayPaths,
    generatedConfigPaths: generatedLayer.files.map((file) => file.path),
    layers,
    provenance: buildProvenance(layers, merged),
    diagnostics,
  };
}
