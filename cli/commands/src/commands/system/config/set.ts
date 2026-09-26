/**
 * config set — the ONLY writer of the user config file (ADR-0047).
 *
 * Writes one key into the user config of a scope (`--scope project`, the
 * default, or `platform`), atomically and under a file lock, preserving the
 * comments and layout of the file. The result is validated against the
 * platform config schemas and, for `adapterOptions.<adapter>`, the adapter's
 * manifest `configSchema`. Secrets must be `${ENV_VAR}` references unless
 * `--allow-plain-secret` is given. Generated files (`.kb/generated/`) are never
 * touched.
 */

import {
  loadEffectiveConfig,
  setUserConfigValue,
  type SetUserConfigResult,
} from '@kb-labs/core-config';
import { PlatformUserConfigSchema } from '@kb-labs/core-runtime';
import type { ErrorEnvelope } from '@kb-labs/core-platform';
import { defineSystemCommand, type CommandResult } from '@kb-labs/shared-command-kit';
import { getContextCwd } from '@kb-labs/shared-cli-ui';

import { generateExamples } from '../../../utils/generate-examples';
import { createAdapterOptionsValidator } from './adapter-schema';
import {
  CONFIG_SCOPES,
  configErrorEnvelope,
  parseKeyPath,
  parseValueArg,
  redactValue,
  renderErrorEnvelope,
  resolveConfigRoots,
  userConfigFileForScope,
  valueAtPath,
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
};

export const configSet = defineSystemCommand<Flags, ConfigSetResult>({
  name: 'set',
  description: 'Set a configuration value in the user config (comments are preserved)',
  longDescription:
    'Writes one key (dotted path) into the user config file of a scope: project (default) or platform. ' +
    'The value is parsed as JSON when it is valid JSON, otherwise stored as a string (use --string to force ' +
    'a string). The write is atomic, locked, and validated against the config schemas and the adapter ' +
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

      const roots = await resolveConfigRoots(getContextCwd(ctx));
      const file = await userConfigFileForScope(roots, scope);
      const effective = await loadEffectiveConfig(roots.projectRoot, {
        platformRoot: roots.sameLocation ? undefined : roots.platformRoot,
      });
      const effectivePlatform = (effective?.data.platform ?? undefined) as { adapters?: unknown } | undefined;
      const validate = createAdapterOptionsValidator(segments, {
        roots: roots.sameLocation ? [roots.projectRoot] : [roots.platformRoot, roots.projectRoot],
        effectiveAdapters: effectivePlatform?.adapters,
      });

      const result: SetUserConfigResult = await setUserConfigValue({
        filePath: file,
        path: segments,
        value,
        schema: PlatformUserConfigSchema,
        validate,
        allowPlainSecret: Boolean(flags['allow-plain-secret']),
        allowMissingEnv: Boolean(flags['allow-missing-env']),
        dryRun: Boolean(flags['dry-run']),
      });

      // A value written to a lower layer can still be shadowed by a higher one.
      const rank: Record<string, number> = { generated: 0, platform: 1, project: 2, overlay: 3 };
      let shadowedBy: ConfigSetResult['shadowedBy'];
      for (const layer of [...(effective?.layers ?? [])].reverse()) {
        if (layer.path === file) {
          break;
        }
        if ((rank[layer.layer] ?? 0) > rank[scope]! && valueAtPath(layer.data, segments).found) {
          shadowedBy = { layer: layer.layer, source: layer.path };
          break;
        }
      }

      return {
        ok: true,
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
      };
    } catch (error) {
      const envelope = configErrorEnvelope(error);
      return { ok: false, error: envelope.message, envelope };
    }
  },
  formatter(result, ctx, flags) {
    if (!result.ok && result.envelope) {
      renderErrorEnvelope(ctx, result.envelope, Boolean(flags.json));
      return;
    }
    if (flags.json) {
      ctx.ui?.json?.({
        ok: true,
        key: result.key,
        scope: result.scope,
        file: result.file,
        dryRun: result.dryRun,
        created: result.created,
        changed: result.changed,
        previous: result.previous ?? null,
        value: result.value ?? null,
        adapterSchemaChecked: result.adapterSchemaChecked,
        shadowedBy: result.shadowedBy,
      });
      return;
    }
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
    const title = !result.changed
      ? 'Already set, nothing to do'
      : result.dryRun
        ? 'Dry run, nothing written'
        : 'Configuration updated';
    ctx.ui.success(title, { sections: [{ header: 'Config', items }] });
  },
});
