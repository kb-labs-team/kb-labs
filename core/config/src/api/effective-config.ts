/**
 * @module @kb-labs/core-config/api/effective-config
 *
 * Canonical "give me the effective raw config" entry point.
 *
 * Assembles config from platform-owned inputs and returns the effective
 * result plus diagnostics (ADR-0052): manifest defaults < generated <
 * platform user < project store < project overlays.
 *
 *   0. Plugin manifest settings defaults.
 *   1. `<platformRoot>/.kb/generated/*.json|jsonc` — generated platform config.
 *   2. `<platformRoot>/.kb/kb.config.*` — platform user config.
 *   3. `$KB_HOME/state/<projectId>/config.jsonc` — project settings.
 *   4. `$KB_HOME/state/<projectId>/overlays/*.jsonc` — scenario overlays.
 *
 * Higher layers replace arrays and scalar values; objects deep-merge.
 * Repository `.kb` files are never read.
 *
 * Returns `null` only when none of the supported layers contributed anything.
 *
 * This is complementary to `@kb-labs/core-runtime :: loadPlatformConfig`,
 * which produces the structured `PlatformConfig` view (adapters, core,
 * execution). Use `loadEffectiveConfig` when you need the full raw shape;
 * use `loadPlatformConfig` when you need platform initialisation.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { readJsonWithDiagnostics, mergeDefined } from '../runtime/runtime.js';
import { AdapterProjectScopeError, PlatformConfigError } from '@kb-labs/core-platform';
import type { Diagnostic } from '../types/index.js';
import { loadOverlays } from '../overlay/loader.js';
import { mergeOverlay } from '../overlay/merge.js';
import { projectOverlaysPath, projectSettingsPath, readProjectSettings } from '../project-settings-store.js';
import { JsoncSyntaxError } from '../user-config/jsonc-edit.js';
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
  /** Deep-merged effective data (manifest → generated → platform → project → overlays). */
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
  /** Non-error diagnostics. Error diagnostics reject the load as PlatformConfigError. */
  diagnostics: Diagnostic[];
}

export interface LoadEffectiveConfigOptions {
  /**
   * Optional platform installation root. When provided and distinct from
   * `projectRoot`, its `kb.config.*` is read first and used as the
   * deep-merge baseline. Overlays are *not* read from this root.
   */
  platformRoot?: string;
  /** Registry-selected project identity for reading platform-owned project settings. */
  projectId?: string;
  /** Machine state root override for isolated runtimes and tests. */
  storeRoot?: string;
  /** Lowest-precedence plugin defaults, each attributed to its manifest. */
  pluginDefaults?: readonly ConfigLayerFile[];
}

async function findAllConfigsInRoot(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const rel of CONFIG_CANDIDATES) {
    const full = path.join(root, rel);
    try {
      await fsp.access(full);
      found.push(full);
    } catch (error) {
      const code = error !== null && typeof error === 'object' && 'code' in error
        ? error.code
        : undefined;
      if (code === 'ENOENT' || code === 'ENOTDIR') {continue;}
      const detail = error instanceof Error ? error.message : String(error);
      throw new PlatformConfigError(full, 'read', detail);
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

function throwConfigDiagnostic(
  diagnostic: Diagnostic,
  fallbackPath: string,
): never {
  const reason = diagnostic.code.includes('PARSE')
    ? 'parse'
    : diagnostic.code.includes('READ')
      ? 'read'
      : 'invalid';
  const detail = 'detail' in diagnostic && typeof diagnostic.detail === 'string'
    ? diagnostic.detail
    : diagnostic.message;
  throw new PlatformConfigError(diagnostic.path ?? fallbackPath, reason, detail);
}

function throwConfigErrors(diagnostics: readonly Diagnostic[], fallbackPath: string): void {
  const diagnostic = diagnostics.find((entry) => entry.level === 'error');
  if (diagnostic) {throwConfigDiagnostic(diagnostic, fallbackPath);}
}

/**
 * Load platform config plus optional platform-owned project settings. The
 * consumer repository is never consulted for `.kb/kb.config.*` or overlays.
 */
export async function loadEffectiveConfig(
  options: LoadEffectiveConfigOptions = {},
): Promise<EffectiveConfigResult | null> {
  const diagnostics: Diagnostic[] = [];

  const platformRoot = options.platformRoot;
  const generatedRoots = platformRoot ? [platformRoot] : [];
  const generatedLayer = await loadGeneratedLayer(generatedRoots);
  diagnostics.push(...generatedLayer.diagnostics);
  throwConfigErrors(generatedLayer.diagnostics, platformRoot ?? '<platform generated config>');

  const platformLayer = platformRoot
    ? await readObjectsAtRoot(platformRoot, diagnostics, 'platform')
    : { paths: [] as string[], data: {} as Record<string, unknown>, files: [] as ConfigLayerFile[] };
  const projectSettingsFile = options.projectId
    ? projectSettingsPath({ projectId: options.projectId, root: options.storeRoot })
    : undefined;
  let projectSettings: Record<string, unknown> = {};
  if (options.projectId) {
    try {
      projectSettings = await readProjectSettings({ projectId: options.projectId, root: options.storeRoot });
    } catch (error) {
      const reason = error instanceof JsoncSyntaxError
        ? 'parse'
        : error !== null && typeof error === 'object' && 'code' in error
          ? 'read'
          : 'invalid';
      const detail = error instanceof Error ? error.message : String(error);
      throw new PlatformConfigError(projectSettingsFile!, reason, detail);
    }
  }
  const projectPlatform = projectSettings.platform;
  if (projectSettings.adapters !== undefined || projectSettings.adapterOptions !== undefined ||
      (projectPlatform !== null && typeof projectPlatform === 'object' && !Array.isArray(projectPlatform) &&
        ((projectPlatform as Record<string, unknown>).adapters !== undefined ||
          (projectPlatform as Record<string, unknown>).adapterOptions !== undefined))) {
    throw new AdapterProjectScopeError();
  }
  let projectSettingsPresent = false;
  if (projectSettingsFile) {
    try {
      await fsp.access(projectSettingsFile);
      projectSettingsPresent = true;
    } catch {
      projectSettingsPresent = false;
    }
  }
  const projectLayer = {
    paths: projectSettingsFile && projectSettingsPresent ? [projectSettingsFile] : [],
    data: projectSettings,
    files: projectSettingsFile && projectSettingsPresent
      ? [{ layer: 'project' as const, path: projectSettingsFile, data: projectSettings }]
      : [] as ConfigLayerFile[],
  };
  const overlayResult = options.projectId
    ? await loadOverlays(projectOverlaysPath({ projectId: options.projectId, root: options.storeRoot }))
    : { overlays: [], diagnostics: [] };
  diagnostics.push(...overlayResult.diagnostics);
  throwConfigErrors(overlayResult.diagnostics, options.projectId
    ? projectOverlaysPath({ projectId: options.projectId, root: options.storeRoot })
    : '<project overlays>');
  throwConfigErrors(diagnostics, platformRoot ?? '<platform config>');
  const nothingFound =
    (options.pluginDefaults?.length ?? 0) === 0 &&
    generatedLayer.files.length === 0 &&
    platformLayer.paths.length === 0 &&
    projectLayer.paths.length === 0 &&
    overlayResult.overlays.length === 0 &&
    overlayResult.diagnostics.length === 0;
  if (nothingFound) {
    return null;
  }

  let merged: Record<string, unknown> = {};
  for (const layer of [
    ...(options.pluginDefaults ?? []),
    ...generatedLayer.files,
    ...platformLayer.files,
    ...projectLayer.files,
  ]) {
    merged = mergeOverlay(merged, layer.data);
  }
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
    ...(options.pluginDefaults ?? []),
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
