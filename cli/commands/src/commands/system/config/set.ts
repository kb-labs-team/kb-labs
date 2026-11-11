/**
 * config set — the ONLY writer of the user config file (ADR-0047).
 *
 * Writes one key into the user config of a scope (`--scope project`, the
 * default, or `platform`), atomically and under a file lock, preserving the
 * comments and layout of the file. Plugin settings are validated against the
 * plugin's resolved manifest schema; adapter options use the adapter manifest
 * `configSchema`. Secrets must be `${ENV_VAR}` references unless
 * `--allow-plain-secret` is given. Generated files (`.kb/generated/`) are never
 * touched.
 */

import {
  ConfigWriteError,
  configErrorEnvelope,
  createAdapterOptionsValidator,
  loadEffectiveConfig,
  redactValue,
  mergeOverlay,
  readProjectSettings,
  PluginSettingsSchemaLoadError,
  resolvePluginSettingsValidator,
  setUserConfigValue,
  writeProjectSetting,
} from '@kb-labs/core-config';
import { loadPlatformConfig, PlatformUserConfigSchema } from '@kb-labs/core-runtime';
import { AdapterProjectScopeError, type ErrorEnvelope } from '@kb-labs/core-platform';
import { defineSystemCommand, throwSystemCataloguedError, throwSystemCataloguedFailure, type CommandResult } from '@kb-labs/shared-command-kit';
import { getContextCwd } from '@kb-labs/shared-cli-ui';

import { generateExamples } from '../../../utils/generate-examples';
import { requireResolvedCatalog } from '../../../registry/discovery-state.js';
import {
  CONFIG_SCOPES,
  parseKeyPath,
  parseValueArg,
  resolveConfigRoots,
  userConfigFileForScope,
  valueAtPath,
  pluginSettingsSchemaFor,
  manifestSettingsLayers,
  type ConfigScope,
} from './shared';

type Flags = {
  scope: { type: 'string'; description?: string; default: string; choices: readonly string[] };
  'dry-run': { type: 'boolean'; description?: string };
  string: { type: 'boolean'; description?: string };
  'allow-plain-secret': { type: 'boolean'; description?: string };
  'allow-missing-env': { type: 'boolean'; description?: string };
  json: { type: 'boolean'; description?: string };
};

export type ConfigSetResult = CommandResult & {
  envelope?: ErrorEnvelope;
  key?: string;
  scope?: ConfigScope;
  file?: string;
  dryRun?: boolean;
  created?: boolean;
  changed?: boolean;
  /** Redacted previous value (`undefined` when the key was not set in this file). */
  previous?: unknown;
  /** Redacted new value. */
  value?: unknown;
  /** True when the adapter's manifest configSchema took part in validation. */
  adapterSchemaChecked?: boolean;
  /** Set when a higher layer still overrides the value just written. */
  shadowedBy?: { layer: string; source: string };
  /** Exact command to activate a changed platform adapter configuration. */
  nextCommand?: string;
};

export const configSet = defineSystemCommand<Flags, ConfigSetResult>({
  name: 'set',
  scope: 'project',
  jsonTest: { noSafeValidPath: "This command writes persistent configuration." },
  description: 'Set a configuration value in the user config (comments are preserved)',
  longDescription:
    'Writes one key (dotted path) into the user config file of a scope: project (default) or platform. ' +
    'The value is parsed as JSON when it is valid JSON, otherwise stored as a string (use --string to force ' +
    'a string). The write is atomic, locked, and validated against plugin settings schemas or the adapter ' +
    'manifest. Secrets must be ${ENV_VAR} references; use --allow-plain-secret only for throwaway values. ' +
    'Use --dry-run to see the outcome without writing.',
  category: 'config',
  aliases: [],
  examples: generateExamples('config set', 'kb', [
    { flags: {}, description: 'platform.adapters.llm @kb-labs/adapters-openai' },
    { flags: { scope: 'platform' }, description: "platform.adapterOptions.llm.apiKey '${OPENAI_API_KEY}'" },
    { flags: { 'dry-run': true, json: true }, description: 'platform.execution.mode worker-pool' },
  ]),
  flags: {
    scope: {
      type: 'string',
      description: 'Which user config to write: project (default) or platform',
      default: 'project',
      choices: CONFIG_SCOPES,
    },
    'dry-run': { type: 'boolean', description: 'Validate and show the outcome without writing' },
    string: { type: 'boolean', description: 'Store the value as a string even if it parses as JSON' },
    'allow-plain-secret': { type: 'boolean', description: 'Allow a raw secret value instead of an ${ENV_VAR} reference' },
    'allow-missing-env': { type: 'boolean', description: 'Allow a secret reference whose environment variable is not set' },
    json: { type: 'boolean', description: 'Output machine-readable JSON' },
  },
  analytics: { command: 'config.set', startEvent: 'CONFIG_SET_STARTED', finishEvent: 'CONFIG_SET_FINISHED' },
  async handler(ctx, argv, flags) {
    try {
      const segments = parseKeyPath(argv[0]);
      const key = segments.join('.');
      const value = parseValueArg(argv[1], Boolean(flags.string), key);
      const scope = flags.scope as ConfigScope;
      if (scope === 'project' && (
        (segments[0] === 'platform' &&
          (segments[1] === 'adapters' || segments[1] === 'adapterOptions')) ||
        segments[0] === 'adapters' || segments[0] === 'adapterOptions'
      )) {
        throw new AdapterProjectScopeError();
      }
      if (scope === 'project' && (segments[0] !== 'plugins' || segments.length < 3)) {
        const correctedPath = `plugins.${key}`;
        const correctedCommand = typeof value === 'boolean' || typeof value === 'number'
          ? `kb config set ${correctedPath} ${String(value)}`
          : undefined;
        throw new ConfigWriteError(
          'KB_CONFIG_INVALID',
          'Project scope accepts plugin settings under plugins.<configSection>.<key>',
          { path: key, ...(correctedCommand ? { nextCommand: correctedCommand } : {}) },
          { reason: 'project-scope-path' },
        );
      }

      const roots = await resolveConfigRoots(getContextCwd(ctx), scope === 'platform' ? 'platform' : 'required');
      if (scope === 'project' && !roots.projectId) {
        throwSystemCataloguedFailure({ code: 'KB_PROJECT_UNKNOWN', message: 'Project config requires a registered project.', hint: `Run "kb project add ${roots.configRoot}" and retry "kb config set".`, details: { path: roots.configRoot } });
      }
      const file = await userConfigFileForScope(roots, scope);
      const runtimeConfig = await loadPlatformConfig({
        moduleUrl: import.meta.url,
        startDir: getContextCwd(ctx),
        loadEnvFile: false,
        projectScope: scope === 'platform' ? 'platform' : 'required',
        catalog: requireResolvedCatalog(),
        ...(roots.projectId ? { projectId: roots.projectId } : {}),
      });
      const platform = await loadEffectiveConfig({
        platformRoot: roots.platformRoot,
        ...(roots.projectId ? { projectId: roots.projectId } : {}),
        pluginDefaults: manifestSettingsLayers(runtimeConfig),
      });
      const projectSettings = roots.projectId ? await readProjectSettings({ projectId: roots.projectId }) : {};
      const effectiveData = mergeOverlay(platform?.data ?? {}, projectSettings) as Record<string, unknown>;
      const platformBaseData = (platform?.layers ?? [])
        .filter(({ layer }) => layer !== 'project' && layer !== 'overlay')
        .reduce<Record<string, unknown>>((merged, layer) => mergeOverlay(merged, layer.data), {});
      const effectivePlatform = (effectiveData.platform ?? undefined) as { adapters?: unknown } | undefined;
      const validate = createAdapterOptionsValidator(segments, {
        platformRoot: roots.platformRoot,
        effectiveAdapters: effectivePlatform?.adapters,
      });
      const pluginSettings = segments[0] === 'plugins' && segments.length >= 3
        ? await pluginSettingsSchemaFor(segments[1]!)
        : undefined;
      const pluginValidator = pluginSettings
        ? await resolvePluginSettingsValidator(pluginSettings.schema, pluginSettings.packageRoot, segments[1])
        : undefined;
      if (segments[0] === 'plugins' && segments.length >= 3 && !pluginSettings) {
        throw new PluginSettingsSchemaLoadError(
          `Plugin settings section "${segments[1]}" has no declared settings schema.`,
          undefined,
          segments[1],
        );
      }
      const manifestDefaults = runtimeConfig.pluginSettingsDefaults
        ?.find(({ configSection }) => configSection === segments[1])?.data ?? {};
      const platformPluginBaseSettings = segments[0] === 'plugins' && segments[1]
        ? valueAtPath(platformBaseData, ['plugins', segments[1]]).value
        : undefined;
      const validatePluginSettings = scope === 'platform' && pluginValidator
        ? async (document: Record<string, unknown>) => {
            const platformSettings = valueAtPath(document, ['plugins', segments[1]!]).value;
            const projectPluginSettings = valueAtPath(projectSettings, ['plugins', segments[1]!]).value;
            const effectiveSettings = mergeOverlay(
              isRecord(platformPluginBaseSettings) ? platformPluginBaseSettings : manifestDefaults,
              mergeOverlay(
                isRecord(platformSettings) ? platformSettings : {},
                isRecord(projectPluginSettings) ? projectPluginSettings : {},
              ),
            );
            const validation = pluginValidator.validate(effectiveSettings);
            if (!validation.valid) {
              const settingPath = segments.join('.');
              throw new ConfigWriteError('KB_PLUGIN_SETTINGS_INVALID', `${settingPath}: ${validation.cause}`, {
                path: settingPath,
              }, { cause: validation.cause });
            }
            return [];
          }
        : undefined;
      const platformPluginSettings = segments[0] === 'plugins' && segments[1]
        ? valueAtPath(effectiveData, ['plugins', segments[1]]).value
        : undefined;

      const result = scope === 'project'
        ? await writeProjectSetting({
            projectId: roots.projectId!,
            path: segments,
            value,
            dryRun: Boolean(flags['dry-run']),
            settingsSchema: pluginSettings?.schema,
            settingsPackageRoot: pluginSettings?.packageRoot,
            baseSettings: platformPluginBaseSettings && typeof platformPluginBaseSettings === 'object' && !Array.isArray(platformPluginBaseSettings)
              ? platformPluginBaseSettings as Record<string, unknown>
              : manifestDefaults,
          }).then((written) => ({
            filePath: written.filePath,
            previousValue: written.previousValue,
            changed: written.changed,
            dryRun: written.dryRun,
            created: written.created,
          }))
        : await setUserConfigValue({
            filePath: file,
            path: segments,
            value,
            schema: PlatformUserConfigSchema,
            validate: validatePluginSettings ?? validate,
            allowPlainSecret: Boolean(flags['allow-plain-secret']),
            allowMissingEnv: Boolean(flags['allow-missing-env']),
            dryRun: Boolean(flags['dry-run']),
          });

      // A value written to a lower layer can still be shadowed by a higher one.
      const rank: Record<string, number> = { generated: 0, platform: 1, project: 2, overlay: 3 };
      let shadowedBy: ConfigSetResult['shadowedBy'];
      const layers = [...(platform?.layers ?? []), {
        layer: 'project' as const,
        path: file,
        data: scope === 'platform' ? {} : projectSettings,
      }];
      for (const layer of [...layers].reverse()) {
        if (layer.path === file) {
          break;
        }
        if ((rank[layer.layer] ?? 0) > rank[scope]! && valueAtPath(layer.data, segments).found) {
          shadowedBy = { layer: layer.layer, source: layer.path };
          break;
        }
      }

      return {

        key,
        scope,
        file: result.filePath,
        dryRun: result.dryRun,
        created: result.created,
        changed: result.changed,
        previous: redactValue(segments, result.previousValue),
        value: redactValue(segments, value),
        adapterSchemaChecked: validate !== undefined,
        shadowedBy,
        nextCommand: scope === 'platform' && segments[0] === 'platform'
          && (segments[1] === 'adapters' || segments[1] === 'adapterOptions')
          && result.changed && !result.dryRun
          ? `kb-create restart --platform-root ${JSON.stringify(roots.platformRoot)}`
          : undefined,
      };
    } catch (error) {
      const envelope = configErrorEnvelope(error);
      throwSystemCataloguedError(envelope);
    }
  },
  formatter(result, ctx, flags) {
    const shown = typeof result.value === 'string' ? result.value : JSON.stringify(result.value);
    const items = [`Key:   ${result.key}`, `Value: ${shown}`, `File:  ${result.file}`, `Scope: ${result.scope}`];
    if (result.changed && result.previous !== undefined) {
      items.push(`Was:   ${typeof result.previous === 'string' ? result.previous : JSON.stringify(result.previous)}`);
    }
    if (result.shadowedBy) {
      items.push(
        `Note:  a ${result.shadowedBy.layer} value in ${result.shadowedBy.source} overrides this one.`,
      );
    }
    if (result.nextCommand) {
      items.push(`Next:  ${result.nextCommand}`);
    }
    const title = !result.changed
      ? 'Already set, nothing to do'
      : result.dryRun
        ? 'Dry run, nothing written'
        : 'Configuration updated';
    ctx.ui.success(title, { sections: [{ header: 'Config', items }] });
  },
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
