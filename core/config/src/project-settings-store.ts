/** Platform-owned project plugin settings (ADR-0052). */

import { promises as fs } from 'node:fs';
import { resolveKbHome, projectSettingsFilePath, projectOverlaysDirPath } from '@kb-labs/core-platform';

import { ConfigWriteError } from './user-config/write-user-config.js';
import { parseJsonc, setUserConfigValue } from './user-config/index.js';
import { PluginSettingsSchemaLoadError, resolvePluginSettingsValidator } from './plugin-settings-schema.js';

export interface ProjectSettingsStoreOptions {
  projectId: string;
  /** KB_HOME override; defaults to `$KB_HOME` or `~/.kb`. */
  root?: string;
  env?: NodeJS.ProcessEnv;
}

export function projectSettingsPath(options: ProjectSettingsStoreOptions): string {
  const home = options.root ?? resolveKbHome(options.env);
  return projectSettingsFilePath(home, options.projectId);
}

export function projectOverlaysPath(options: ProjectSettingsStoreOptions): string {
  const home = options.root ?? resolveKbHome(options.env);
  return projectOverlaysDirPath(home, options.projectId);
}

/** Read a project's plugin settings without consulting the project repository. */
export async function readProjectSettings(
  options: ProjectSettingsStoreOptions,
): Promise<Record<string, unknown>> {
  const filePath = projectSettingsPath(options);
  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  const value = parseJsonc(text);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Project settings file ${filePath} must contain a JSON object`);
  }
  return value as Record<string, unknown>;
}

/** Atomically update a value in a project's platform-owned JSONC settings file. */
export async function writeProjectSetting(
  options: ProjectSettingsStoreOptions & {
    path: readonly string[];
    value: unknown;
    dryRun?: boolean;
    /** JSON Schema for the plugin's complete settings object, if declared. */
    settingsSchema?: unknown;
    settingsPackageRoot?: string;
    /** Plugin defaults and platform values under the same configSection. */
    baseSettings?: Record<string, unknown>;
  },
): Promise<{ filePath: string; previousValue: unknown; changed: boolean; created: boolean; dryRun: boolean }> {
  const filePath = projectSettingsPath(options);
  const pluginId = options.path[1];
  let validator: Awaited<ReturnType<typeof resolvePluginSettingsValidator>> | undefined;
  if (pluginId) {
    if (!options.settingsSchema) {
      throw new PluginSettingsSchemaLoadError(`Plugin "${pluginId}" has no declared settings schema.`, undefined, pluginId);
    }
    if (!options.settingsPackageRoot && isSchemaReference(options.settingsSchema)) {
      throw new PluginSettingsSchemaLoadError(`Plugin "${pluginId}" settings schema requires its package location.`, undefined, pluginId);
    }
    validator = await resolvePluginSettingsValidator(
      options.settingsSchema,
      options.settingsPackageRoot ?? process.cwd(),
      pluginId,
    );
  }
  const result = await setUserConfigValue({
    filePath,
    path: options.path,
    value: options.value,
    dryRun: options.dryRun,
    validate: validator && pluginId
      ? (nextDocument) => {
          const nextPlugins = isRecord(nextDocument.plugins) ? nextDocument.plugins : {};
          const nextPluginSettings = isRecord(nextPlugins[pluginId]) ? nextPlugins[pluginId] : {};
          const validation = validator.validate(mergeSettings(options.baseSettings ?? {}, nextPluginSettings));
          if (!validation.valid) {
            const settingPath = options.path.join('.');
            throw new ConfigWriteError('KB_PLUGIN_SETTINGS_INVALID', `${settingPath}: ${validation.cause}`, {
              path: settingPath,
            }, { cause: validation.cause });
          }
          return [];
        }
      : undefined,
  });
  return {
    filePath: result.filePath,
    previousValue: result.previousValue,
    changed: result.changed,
    created: result.created,
    dryRun: result.dryRun,
  };
}

function isSchemaReference(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (Object.keys(value).length === 1 && typeof value.$ref === 'string') ||
    (Object.keys(value).length === 1 && typeof value.zod === 'string');
}

function mergeSettings(lower: unknown, higher: unknown): unknown {
  if (!isRecord(lower) || !isRecord(higher)) return higher;
  const result: Record<string, unknown> = { ...lower };
  for (const [key, value] of Object.entries(higher)) {
    result[key] = Object.prototype.hasOwnProperty.call(lower, key)
      ? mergeSettings(lower[key], value)
      : value;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
