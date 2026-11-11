/**
 * Shared helpers for `kb config get | set | show` (ADR-0047, docs 06/08).
 *
 * The commands work directly on the config files through `@kb-labs/core-config`
 * (there is no host yet): layered read with provenance for `get`/`show`, and
 * the single locked, comment-preserving writer for `set`.
 */

import { requireResolvedCatalog } from '../../../registry/discovery-state.js';

import {
  ConfigWriteError,
  projectSettingsPath,
  type ConfigLayerName,
  resolveUserConfigFile,
} from '@kb-labs/core-config';
import { createProjectRegistry } from '@kb-labs/core-project-registry';
import { loadPlatformConfig, requireProjectContext } from '@kb-labs/core-runtime';
import { resolveProjectRoot, resolveRoots } from '@kb-labs/core-workspace';
import type { ConfigLayerFile } from '@kb-labs/core-config';
import type { LoadPlatformConfigResult } from '@kb-labs/core-runtime';
import { throwSystemCataloguedFailure } from '@kb-labs/shared-command-kit';

export const CONFIG_SCOPES = ['platform', 'project'] as const;
export type ConfigScope = (typeof CONFIG_SCOPES)[number];

export interface ConfigRoots {
  platformRoot: string;
  projectRoot?: string;
  /** Root used to read the selected config scope. */
  configRoot: string;
  projectScope: 'required' | 'platform';
  projectId?: string;
  sameLocation: boolean;
}

/** Resolve the platform and project roots the way every other command does (ADR-0012). */
export async function resolveConfigRoots(
  cwd: string,
  projectScope: 'required' | 'platform' = 'required',
  moduleUrl = import.meta.url,
): Promise<ConfigRoots> {
  if (projectScope === 'platform') {
    const roots = await resolveRoots({ moduleUrl, startDir: cwd, projectScope: 'platform' });
    return {
      platformRoot: roots.platformRoot,
      projectRoot: roots.projectRoot,
      configRoot: roots.platformRoot,
      projectScope,
      sameLocation: roots.sameLocation,
    };
  }
  const { rootDir: projectRoot } = await resolveProjectRoot({ cwd });
  const { projects } = await createProjectRegistry().list();
  const project = projects.find(({ project }) => project.path === projectRoot)?.project;
  if (!project) {
    requireProjectContext(undefined, projectRoot);
  }
  const loaded = await loadPlatformConfig({ moduleUrl, startDir: cwd, loadEnvFile: false, catalog: requireResolvedCatalog() });
  return {
    platformRoot: loaded.platformRoot,
    projectRoot: project.path,
    configRoot: project.path,
    projectScope,
    projectId: project.id,
    sameLocation: loaded.platformRoot === project.path,
  };
}

/** The user config file a scope writes to. */
export async function userConfigFileForScope(roots: ConfigRoots, scope: ConfigScope): Promise<string> {
  if (scope === 'project') {
    if (!roots.projectId) {
      const projectRoot = roots.projectRoot ?? roots.configRoot;
      throwSystemCataloguedFailure({ code: 'KB_PROJECT_UNKNOWN', message: 'Project config requires a registered project.', hint: `Run "kb project add ${projectRoot}" to register it, then retry the config command.`, details: { path: projectRoot } });
    }
    return projectSettingsPath({ projectId: roots.projectId });
  }
  return resolveUserConfigFile(roots.platformRoot);
}

/** Load an inline JSON Schema declared by the installed plugin for this setting section. */
export async function pluginSettingsSchemaFor(
  configSection: string,
): Promise<{ schema: unknown; packageRoot: string } | undefined> {
  const catalog = requireResolvedCatalog();
  const discovered = catalog.discovery();
  const manifest = [...discovered.manifests.values()].find((candidate) => candidate.configSection === configSection);
  if (!manifest?.settings) {return undefined;}
  const plugin = discovered.plugins.find(({ id }) => id === manifest.id);
  if (!plugin) {return undefined;}
  return { schema: manifest.settings.schema, packageRoot: plugin.packageRoot };
}

export function manifestSettingsLayers(result: LoadPlatformConfigResult): ConfigLayerFile[] {
  return (result.pluginSettingsDefaults ?? []).map(({ configSection, manifestPath, data }) => ({
    layer: 'manifest',
    path: manifestPath,
    data: { plugins: { [configSection]: data } },
  }));
}

/**
 * Split `a.b.c` into segments. Empty segments are rejected because they can
 * never address a key. (Keys that contain a literal dot cannot be addressed;
 * config keys in this repository do not use them.)
 */
export function parseKeyPath(key: string | undefined): string[] {
  if (key === undefined || key.trim() === '') {
    throw new ConfigWriteError('KB_CONFIG_INVALID', 'A configuration key is required', { path: '' });
  }
  const segments = key.trim().split('.');
  if (segments.some((segment) => segment === '')) {
    throw new ConfigWriteError('KB_CONFIG_INVALID', `Invalid configuration key "${key}"`, { path: key });
  }
  return segments;
}

/**
 * Parse the CLI value: valid JSON (`true`, `3`, `"x"`, `null`, `[..]`, `{..}`)
 * is used as JSON, anything else is a plain string. Something that starts like
 * JSON structure but does not parse is rejected rather than stored as a string.
 */
export function parseValueArg(raw: string | undefined, forceString: boolean, keyName: string): unknown {
  if (raw === undefined) {
    throw new ConfigWriteError('KB_CONFIG_INVALID', `A value is required for ${keyName}`, { path: keyName });
  }
  if (forceString) {
    return raw;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    if (/^\s*[[{]/.test(raw)) {
      throw new ConfigWriteError('KB_CONFIG_INVALID', `The value for ${keyName} looks like JSON but does not parse`, {
        path: keyName,
      });
    }
    return raw;
  }
}

export function valueAtPath(data: unknown, path: readonly string[]): { found: boolean; value?: unknown } {
  let current: unknown = data;
  for (const segment of path) {
    if (current === null || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, segment)) {
      return { found: false };
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return { found: true, value: current };
}

/** Layer label used in human output. */
export function layerLabel(layer: ConfigLayerName | undefined): string {
  return layer ?? '-';
}
