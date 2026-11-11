/**
 * config:show — print the effective (merged) platform config with per-field
 * provenance (platform / project / both / ignored).
 *
 * See ADR-0012 (config field scope) and ADR-0013 (installer-config-placement)
 * for why the project's `.kb/kb.config.jsonc` is often near-empty in prod
 * installs: the platform root holds the full installer-owned config, the
 * project root holds only a pointer + mergeable overrides.
 */

import { defineSystemCommand, throwSystemCataloguedError, throwSystemCataloguedFailure, type CommandResult } from '@kb-labs/shared-command-kit';
import { loadPlatformConfig } from '@kb-labs/core-runtime';
import {
  configErrorEnvelope,
  loadEffectiveConfig,
  type ConfigLayerName,
  type ValueProvenance,
} from '@kb-labs/core-config';
import { generateExamples } from '../../../utils/generate-examples';
import { requireResolvedCatalog } from '../../../registry/discovery-state.js';
import { getContextCwd } from '@kb-labs/shared-cli-ui';
import { manifestSettingsLayers, resolveConfigRoots } from './shared';

// ── Redaction ────────────────────────────────────────────────────────────────

/** Field-name pattern used to redact sensitive values from output. */
const SENSITIVE_FIELD_PATTERN = /key|secret|token|password|jwt|credential/i;

function isSensitiveField(dottedField: string): boolean {
  return dottedField.split('.').some((segment) => SENSITIVE_FIELD_PATTERN.test(segment));
}

const REDACTED = '***REDACTED***';

// ── Row model ────────────────────────────────────────────────────────────────

type ConfigFieldSource = 'manifest' | 'generated' | 'platform' | 'project' | 'overlay' | 'both' | 'ignored';

type ConfigRow = {
  source: ConfigFieldSource;
  field: string;
  value: unknown;
  /**
   * Config layer that supplied the value (ADR-0052): manifest, generated,
   * platform, project store or project overlay.
   * Absent when the layered read could not attribute the field.
   */
  layer?: ConfigLayerName;
  /** File the value was read from. */
  file?: string;
};

/**
 * Attach per-value provenance from the layered loader. Rows are keyed by the
 * merged `PlatformConfig` view (`adapters.llm`), while files spell the same
 * value `platform.adapters.llm` (or, for options, a top-level `adapterOptions`
 * that replaces the nested one), so try those spellings.
 */
function attachProvenance(rows: ConfigRow[], provenance: Record<string, ValueProvenance> | undefined): void {
  if (!provenance) {
    return;
  }
  for (const row of rows) {
    const candidates = row.field.startsWith('adapterOptions.')
      ? [row.field, `platform.${row.field}`]
      : [`platform.${row.field}`, row.field];
    const origin = candidates.map((candidate) => provenance[candidate]).find((entry) => entry !== undefined);
    if (origin) {
      row.layer = origin.layer;
      row.file = origin.source;
      if (row.source !== 'both' && row.source !== 'ignored') {
        row.source = origin.layer;
      }
    }
  }
}

/** Recursively flattens an object into dotted-path leaves. Arrays are kept as leaves. */
function flatten(prefix: string, value: unknown, out: Array<{ field: string; value: unknown }>): void {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      out.push({ field: prefix, value: {} });
      return;
    }
    for (const [key, nested] of entries) {
      flatten(prefix ? `${prefix}.${key}` : key, nested, out);
    }
    return;
  }
  out.push({ field: prefix, value });
}

/**
 * Redacts a leaf value based on its dotted field name. `flatten` stops
 * recursing at arrays (they're kept as a single leaf for display), so a leaf
 * value can still be an array/object containing further nested keys — e.g.
 * `adapterOptions.llm.tierMapping` is an array-of-objects whose entries may
 * carry per-entry credentials. Walk into arrays and nested objects so a
 * sensitive key anywhere inside a leaf's value is still redacted, not just
 * when the sensitive segment is part of the leaf's own dotted path.
 */
function redactLeaf(field: string, value: unknown): unknown {
  if (isSensitiveField(field)) {
    return REDACTED;
  }
  return redactNested(field, value);
}

function redactNested(fieldPath: string, value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactNested(fieldPath, item));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      const childPath = fieldPath ? `${fieldPath}.${key}` : key;
      out[key] = isSensitiveField(childPath) ? REDACTED : redactNested(childPath, nested);
    }
    return out;
  }
  return value;
}

// Top-level fields covered by the platform<->project merge policy (ADR-0012).
const PLATFORM_SCOPE_FIELDS = new Set(['platform', 'adapters', 'adapterOptions', 'core', 'execution']);

function buildRows(
  result: Awaited<ReturnType<typeof loadPlatformConfig>>,
): ConfigRow[] {
  const rows: ConfigRow[] = [];
  const fieldSources = result.sources.fields ?? {};
  const defaultOtherSource: ConfigFieldSource = result.sameLocation ? 'both' : 'project';

  // 1. Fields governed by the platform<->project merge policy. In
  //    `sameLocation` mode (monorepo/dev — platformRoot === projectRoot) a
  //    single physical file plays both roles, so loadPlatformConfig's merge
  //    is a no-op and reports every resolved field as 'platform' (there is
  //    no second layer to merge against — see config-loader.ts's samePath
  //    branch). Editing that one file IS editing both "platform" and
  //    "project" at once, so labeling it 'platform' here would misleadingly
  //    suggest the project layer has no say over it. Report 'both' instead,
  //    consistent with how section 3 already treats sameLocation fields.
  const platformConfig = result.platformConfig as unknown as Record<string, unknown>;
  for (const [topField, rawSource] of Object.entries(fieldSources)) {
    const value = platformConfig[topField];
    if (value === undefined) {
      continue;
    }
    const source: ConfigFieldSource = result.sameLocation ? 'both' : rawSource;
    const leaves: Array<{ field: string; value: unknown }> = [];
    flatten(topField, value, leaves);
    for (const leaf of leaves) {
      rows.push({ source, field: leaf.field, value: redactLeaf(leaf.field, leaf.value) });
    }
  }

  // 2. Fields the project tried to override that were rejected as platform-only.
  //    The value shown is the platform's winning value (project's attempt was dropped).
  for (const ignoredField of result.sources.ignoredProjectFields ?? []) {
    const value = platformConfig[ignoredField];
    const leaves: Array<{ field: string; value: unknown }> = [];
    flatten(ignoredField, value, leaves);
    for (const leaf of leaves) {
      rows.push({ source: 'ignored', field: leaf.field, value: redactLeaf(leaf.field, leaf.value) });
    }
  }

  // 3. Other top-level product config fields (e.g. `services`, `plugins`) that
  //    live outside the PlatformConfig merge policy. These have no
  //    CONFIG_FIELD_SCOPE entry, so loadPlatformConfig does not merge them
  //    into PlatformConfig. Use the full effective config for defaults and
  //    project settings, while retaining raw platform values for provenance.
  const rawPlatformConfig = (result.rawPlatformConfig ?? {}) as Record<string, unknown>;
  const effectiveConfig = (result.effectiveConfig ?? {}) as Record<string, unknown>;
  const otherTopFields = new Set([...Object.keys(rawPlatformConfig), ...Object.keys(effectiveConfig)]);
  for (const topField of otherTopFields) {
    if (PLATFORM_SCOPE_FIELDS.has(topField)) {
      continue;
    }
    const hasPlatform = rawPlatformConfig[topField] !== undefined;
    const hasProject = effectiveConfig[topField] !== undefined;

    let source: ConfigFieldSource;
    let value: unknown;
    if (result.sameLocation) {
      source = 'both';
      value = hasProject ? effectiveConfig[topField] : rawPlatformConfig[topField];
    } else if (hasPlatform && hasProject) {
      source = 'both';
      value = effectiveConfig[topField];
    } else if (hasProject) {
      source = defaultOtherSource;
      value = effectiveConfig[topField];
    } else {
      source = 'platform';
      value = rawPlatformConfig[topField];
    }

    const leaves: Array<{ field: string; value: unknown }> = [];
    flatten(topField, value, leaves);
    for (const leaf of leaves) {
      rows.push({ source, field: leaf.field, value: redactLeaf(leaf.field, leaf.value) });
    }
  }

  rows.sort((a, b) => (a.source === b.source ? a.field.localeCompare(b.field) : a.source.localeCompare(b.source)));
  return rows;
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value);
}

// ── Command ──────────────────────────────────────────────────────────────────

type ConfigShowFlags = {
  json: { type: 'boolean'; description?: string };
};

type ConfigShowResult = CommandResult & {
  envelope?: import('@kb-labs/core-platform').ErrorEnvelope;
  fields?: ConfigRow[];
  sameLocation?: boolean;
  platformRoot?: string;
  projectRoot?: string;
  /** Installer-generated files that supplied the lowest layer, when any. */
  generated?: string[];
};

export const configShow = defineSystemCommand<ConfigShowFlags, ConfigShowResult>({
  name: 'show',
  scope: 'project',
  jsonTest: { safeArgs: [] },
  description: 'Show the effective (merged) platform config with per-field provenance',
  longDescription:
    'Resolves the fully-merged config (manifest defaults, generated and platform config, project settings, and overlays) and ' +
    'prints each field alongside where it came from: manifest, generated, platform, project, both, or ignored ' +
    '(a project attempt to override a platform-only field). Sensitive values ' +
    '(keys, secrets, tokens, passwords, credentials) are always redacted.',
  category: 'config',
  aliases: [],
  examples: generateExamples('config show', 'kb', [
    { flags: {} },
    { flags: { json: true } },
  ]),
  flags: {
    json: { type: 'boolean', description: 'Output machine-readable JSON' },
  },
  analytics: {
    command: 'config.show',
    startEvent: 'CONFIG_SHOW_STARTED',
    finishEvent: 'CONFIG_SHOW_FINISHED',
  },
  async handler(ctx) {
    try {
      const cwd = getContextCwd(ctx);
      const roots = await resolveConfigRoots(cwd);
      if (!roots.projectId) {
        throwSystemCataloguedFailure({ code: 'KB_PROJECT_UNKNOWN', message: 'Effective config requires a registered project.', hint: `Run "kb project add ${roots.configRoot}" and retry "kb config show".`, details: { path: roots.configRoot } });
      }
      const result = await loadPlatformConfig({ moduleUrl: import.meta.url, startDir: cwd, loadEnvFile: false, projectId: roots.projectId, catalog: requireResolvedCatalog() });
      const rows = buildRows(result);

      // Platform provenance remains available from the platform config layer.
      const effective = await loadEffectiveConfig({
        platformRoot: result.platformRoot,
        projectId: roots.projectId,
        pluginDefaults: manifestSettingsLayers(result),
      }).catch(() => null);
      attachProvenance(rows, effective?.provenance);

      return {

        fields: rows,
        sameLocation: result.sameLocation,
        platformRoot: result.platformRoot,
        projectRoot: result.projectRoot,
        generated: result.sources.generated,
      };
    } catch (error) {
      const envelope = configErrorEnvelope(error);
      throwSystemCataloguedError(envelope);
    }
  },
  formatter(result, ctx, flags) {
    const rows = result.fields ?? [];

    if (rows.length === 0) {
      ctx.ui.success('Effective Config', {
        sections: [{ header: 'Config', items: ['No config fields resolved.'] }],
      });
      return;
    }

    const fieldWidth = Math.max(...rows.map((r) => r.field.length), 'FIELD'.length);
    const sourceWidth = Math.max(...rows.map((r) => r.source.length), 'SOURCE'.length);
    const layerWidth = Math.max(...rows.map((r) => (r.layer ?? '-').length), 'LAYER'.length);

    const lines = [
      `${'SOURCE'.padEnd(sourceWidth)}  ${'LAYER'.padEnd(layerWidth)}  ${'FIELD'.padEnd(fieldWidth)}  VALUE`,
      ...rows.map(
        (r) =>
          `${r.source.padEnd(sourceWidth)}  ${(r.layer ?? '-').padEnd(layerWidth)}  ${r.field.padEnd(fieldWidth)}  ${formatValue(r.value)}`,
      ),
    ];

    if (result.sameLocation) {
      lines.push('', '(sameLocation: platform and project resolve to the same file — merge is a no-op)');
    }

    ctx.ui.success('Effective Config', {
      sections: [{ header: 'Config', items: lines }],
    });
  },
});
