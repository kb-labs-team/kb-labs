/**
 * config get — read one key, with the layer and file it came from.
 *
 * Without `--scope` the EFFECTIVE value is read (generated < platform user <
 * project user < overlays, ADR-0047/ADR-0012) and reported with its
 * provenance. With `--scope platform|project` only that scope's user config
 * file is read. Raw secrets are redacted; `${ENV_VAR}` references are shown.
 */

import {
  ConfigWriteError,
  loadEffectiveConfig,
  parseJsonc,
  resolveKeyPath,
  type ConfigLayerName,
  type ValueProvenance,
} from '@kb-labs/core-config';
import { PlatformUserConfigSchema } from '@kb-labs/core-runtime';
import type { ErrorEnvelope } from '@kb-labs/core-platform';
import { defineSystemCommand, type CommandResult } from '@kb-labs/shared-command-kit';
import { getContextCwd } from '@kb-labs/shared-cli-ui';
import { promises as fsp } from 'node:fs';

import { generateExamples } from '../../../utils/generate-examples';
import {
  CONFIG_SCOPES,
  configErrorEnvelope,
  layerLabel,
  parseKeyPath,
  redactValue,
  renderErrorEnvelope,
  resolveConfigRoots,
  userConfigFileForScope,
  valueAtPath,
  type ConfigScope,
} from './shared';

type Flags = {
  scope: { type: 'string'; description?: string; choices: readonly string[] };
  json: { type: 'boolean'; description?: string };
};

export type ConfigGetResult = CommandResult & {
  envelope?: ErrorEnvelope;
  key?: string;
  /** `effective` unless `--scope` was given. */
  scope?: ConfigScope | 'effective';
  found?: boolean;
  /** Redacted value (raw secrets never leave the process). */
  value?: unknown;
  layer?: ConfigLayerName;
  source?: string;
  /** Layers that contributed items to an array value (arrays concatenate), highest first. */
  contributors?: ValueProvenance['contributors'];
};

/** Provenance of a key or of the closest leaf beneath / above it. */
function provenanceFor(
  provenance: Record<string, ValueProvenance>,
  segments: readonly string[],
): ValueProvenance | undefined {
  const dotted = segments.join('.');
  const exact = provenance[dotted];
  if (exact) {
    return exact;
  }
  // A container: report the highest-precedence layer among the leaves beneath it.
  const order: ConfigLayerName[] = ['overlay', 'project', 'platform', 'generated'];
  const beneath = Object.entries(provenance).filter(([key]) => key.startsWith(`${dotted}.`));
  for (const layer of order) {
    const hit = beneath.find(([, value]) => value.layer === layer);
    if (hit) {
      return { layer, source: hit[1].source };
    }
  }
  return undefined;
}

export const configGet = defineSystemCommand<Flags, ConfigGetResult>({
  name: 'get',
  description: 'Read a configuration value and show which layer it came from',
  longDescription:
    'Reads one key (dotted path, for example platform.adapters.llm). By default the effective value is ' +
    'returned with its provenance (generated, platform, project or overlay layer). Use --scope to read ' +
    'only the user config file of one scope. Raw secrets are redacted; ${ENV_VAR} references are shown.',
  category: 'config',
  aliases: [],
  examples: generateExamples('config get', 'kb', [
    { flags: {}, description: 'platform.adapters.llm' },
    { flags: { scope: 'platform', json: true }, description: 'platform.adapterOptions.llm.defaultModel' },
  ]),
  flags: {
    scope: {
      type: 'string',
      description: 'Read only this scope (platform | project). Default: the effective merged value',
      choices: CONFIG_SCOPES,
    },
    json: { type: 'boolean', description: 'Output machine-readable JSON' },
  },
  analytics: { command: 'config.get', startEvent: 'CONFIG_GET_STARTED', finishEvent: 'CONFIG_GET_FINISHED' },
  async handler(ctx, argv, flags) {
    try {
      const segments = parseKeyPath(argv[0]);
      const key = segments.join('.');

      const resolution = resolveKeyPath(PlatformUserConfigSchema, segments);
      if (resolution.status === 'unknown') {
        throw new ConfigWriteError('KB_CONFIG_UNKNOWN_KEY', `Unknown configuration key ${key}`, {
          path: key,
          key: resolution.key,
          parent: resolution.parentPath,
          suggestion: resolution.suggestion ?? '',
          knownKeys: resolution.knownKeys.join(','),
        });
      }

      const roots = await resolveConfigRoots(getContextCwd(ctx));

      if (flags.scope) {
        const scope = flags.scope as ConfigScope;
        const file = await userConfigFileForScope(roots, scope);
        let text: string;
        try {
          text = await fsp.readFile(file, 'utf8');
        } catch {
          return { ok: true, key, scope, found: false, source: file };
        }
        let document: unknown;
        try {
          document = parseJsonc(text);
        } catch (error) {
          throw new ConfigWriteError('KB_CONFIG_INVALID', `${file} is not valid JSONC: ${(error as Error).message}`, {
            path: file,
          });
        }
        const hit = valueAtPath(document, segments);
        return {
          ok: true,
          key,
          scope,
          found: hit.found,
          value: hit.found ? redactValue(segments, hit.value) : undefined,
          layer: scope,
          source: file,
        };
      }

      const effective = await loadEffectiveConfig(roots.projectRoot, {
        platformRoot: roots.sameLocation ? undefined : roots.platformRoot,
      });
      const hit = valueAtPath(effective?.data, segments);
      if (!hit.found || !effective) {
        return { ok: true, key, scope: 'effective', found: false };
      }
      const origin = provenanceFor(effective.provenance, segments);
      return {
        ok: true,
        key,
        scope: 'effective',
        found: true,
        value: redactValue(segments, hit.value),
        layer: origin?.layer,
        source: origin?.source,
        contributors: origin?.contributors,
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
        found: result.found,
        value: result.value ?? null,
        layer: result.layer ?? null,
        source: result.source ?? null,
        contributors: result.contributors,
      });
      return;
    }
    if (!result.found) {
      ctx.ui.info(`${result.key} is not set${result.scope === 'effective' ? '' : ` in the ${result.scope} scope`}.`);
      return;
    }
    const printed = typeof result.value === 'string' ? result.value : JSON.stringify(result.value);
    // Value only, so `$(kb config get key)` stays usable; provenance is in --json and `config show`.
    ctx.ui.write(`${printed}\n`);
    ctx.ui.debug?.(`layer: ${layerLabel(result.layer)}${result.source ? ` (${result.source})` : ''}`);
  },
});
