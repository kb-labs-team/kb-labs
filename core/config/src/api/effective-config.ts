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
 *   2. Platform user config candidates, in shared precedence order.
 *   3. `<platformRoot>/.kb/kb.config.override.json` — container topology layer.
 *   4. `$KB_HOME/state/<projectId>/config.jsonc` — project settings.
 *   5. `$KB_HOME/state/<projectId>/overlays/*.jsonc` — scenario overlays.
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

import { AdapterProjectScopeError, PlatformConfigError } from '@kb-labs/core-platform';
import type { Diagnostic } from '../types/index.js';
import { loadOverlays } from '../overlay/loader.js';
import { mergeOverlay } from '../overlay/merge.js';
import { projectOverlaysPath, projectSettingsPath, readProjectSettings } from '../project-settings-store.js';
import { JsoncSyntaxError } from '../user-config/jsonc-edit.js';
import {
  buildProvenance,
  loadGeneratedLayer,
  loadPlatformUserLayerFiles,
  loadPlatformContainerLayer,
  type ConfigLayerFile,
  type ValueProvenance,
} from '../user-config/layers.js';

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
   * Optional platform installation root. When provided, its generated and
   * platform user layers are read before platform-owned project settings.
   * Project overlays are read from the platform state store.
   */
  platformRoot?: string;
  /** Registry-selected project identity for reading platform-owned project settings. */
  projectId?: string;
  /** Machine state root override for isolated runtimes and tests. */
  storeRoot?: string;
  /** Lowest-precedence plugin defaults, each attributed to its manifest. */
  pluginDefaults?: readonly ConfigLayerFile[];
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
    ? await loadPlatformUserLayerFiles(platformRoot)
    : { paths: [] as string[], data: {} as Record<string, unknown>, files: [], diagnostics: [] };
  const containerLayer = platformRoot
    ? await loadPlatformContainerLayer(platformRoot)
    : { paths: [] as string[], data: {} as Record<string, unknown>, files: [], diagnostics: [] };
  diagnostics.push(...platformLayer.diagnostics, ...containerLayer.diagnostics);
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
    containerLayer.paths.length === 0 &&
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
    ...containerLayer.files,
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
    ...containerLayer.files,
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
