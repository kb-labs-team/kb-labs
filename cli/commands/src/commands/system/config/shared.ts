/**
 * Shared helpers for `kb config get | set | show` (ADR-0047, docs 06/08).
 *
 * The commands work directly on the config files through `@kb-labs/core-config`
 * (there is no host yet): layered read with provenance for `get`/`show`, and
 * the single locked, comment-preserving writer for `set`.
 */

import {
  ConfigWriteError,
  type ConfigLayerName,
  isEnvReference,
  isSecretKeyPath,
  resolveUserConfigFile,
} from '@kb-labs/core-config';
import { loadPlatformConfig } from '@kb-labs/core-runtime';
import {
  createErrorEnvelope,
  toErrorEnvelope,
  type ErrorEnvelope,
} from '@kb-labs/core-platform';
import type { PluginContextV3 } from '@kb-labs/plugin-contracts';

export const CONFIG_SCOPES = ['platform', 'project'] as const;
export type ConfigScope = (typeof CONFIG_SCOPES)[number];

export const REDACTED = '***REDACTED***';

export interface ConfigRoots {
  platformRoot: string;
  projectRoot: string;
  sameLocation: boolean;
}

/** Resolve the platform and project roots the way every other command does (ADR-0012). */
export async function resolveConfigRoots(cwd: string): Promise<ConfigRoots> {
  const loaded = await loadPlatformConfig({ startDir: cwd, loadEnvFile: false });
  return {
    platformRoot: loaded.platformRoot,
    projectRoot: loaded.projectRoot,
    sameLocation: loaded.sameLocation,
  };
}

/** The user config file a scope writes to. */
export async function userConfigFileForScope(roots: ConfigRoots, scope: ConfigScope): Promise<string> {
  return resolveUserConfigFile(scope === 'platform' ? roots.platformRoot : roots.projectRoot);
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

/** Redact secret leaves (raw credentials); `${ENV}` references are safe and stay visible. */
export function redactValue(path: readonly string[], value: unknown): unknown {
  if (typeof value === 'string') {
    return isSecretKeyPath(path) && !isEnvReference(value) && value.trim() !== '' ? REDACTED : value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => redactValue([...path, String(index)], item));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = redactValue([...path, key], nested);
    }
    return out;
  }
  return value;
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

// ── Error envelope ───────────────────────────────────────────────────────────

function unknownKeyEnvelope(error: ConfigWriteError): ErrorEnvelope {
  const suggestion = error.details.suggestion;
  return createErrorEnvelope('KB_CONFIG_UNKNOWN_KEY', {
    details: {
      path: error.details.path ?? '',
      suggestion: suggestion
        ? `Did you mean "${replaceKey(error.details.path ?? '', error.details.key ?? '', suggestion)}"?`
        : 'No similar key was found.',
    },
    cause: error.details.knownKeys
      ? `"${error.details.parent || '(top level)'}" declares: ${error.details.knownKeys.split(',').join(', ')}`
      : undefined,
  });
}

function replaceKey(path: string, wrong: string, right: string): string {
  return path
    .split('.')
    .map((segment) => (segment === wrong ? right : segment))
    .join('.');
}

/** Build the unified envelope for a failed config command. Never contains values. */
export function configErrorEnvelope(error: unknown): ErrorEnvelope {
  if (!(error instanceof ConfigWriteError)) {
    return toErrorEnvelope(error);
  }
  switch (error.code) {
    case 'KB_CONFIG_UNKNOWN_KEY':
      return unknownKeyEnvelope(error);
    case 'KB_CONFIG_SECRET_MISSING':
      return createErrorEnvelope('KB_CONFIG_SECRET_MISSING', {
        details: { variable: error.details.variable ?? '', path: error.details.path ?? '' },
        cause: `${error.details.path ?? 'The value'} is a secret and refers to \${${error.details.variable ?? ''}}, which is not set in this environment.`,
      });
    case 'KB_CONFIG_SECRET_PLAINTEXT': {
      const path = error.details.path ?? '';
      const variable = suggestVariableName(path);
      return createErrorEnvelope('KB_CONFIG_SECRET_PLAINTEXT', {
        details: { path, example: `kb config set ${path} '\${${variable}}'` },
        cause:
          error.details.reason === 'secret-shape'
            ? 'The value has the shape of a credential.'
            : 'The key is declared secret, so its value must be an ${ENV_VAR} reference.',
      });
    }
    case 'KB_CONFIG_CONFLICT':
      return createErrorEnvelope('KB_CONFIG_CONFLICT', {
        details: { path: error.details.path ?? '' },
        cause: error.message,
      });
    case 'KB_CONFIG_INVALID':
      return createErrorEnvelope('KB_CONFIG_INVALID', {
        details: { path: error.details.path ?? '' },
        cause: error.message,
      });
  }
}

function suggestVariableName(path: string): string {
  const tail = path.split('.').slice(-2).join('_');
  return tail.replace(/[^A-Za-z0-9]+/g, '_').replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase() || 'MY_SECRET';
}

/** Print an envelope: one compact JSON object with `--json`, otherwise a readable message. */
export function renderErrorEnvelope(ctx: PluginContextV3, envelope: ErrorEnvelope, json: boolean): void {
  if (json) {
    ctx.ui?.json?.({ ok: false, error: envelope });
    return;
  }
  const lines = [`${envelope.message} [${envelope.code}]`];
  if (envelope.cause) {
    lines.push(`  Cause: ${envelope.cause}`);
  }
  lines.push(`  Hint:  ${envelope.hint}`);
  ctx.ui?.error?.(lines.join('\n'));
}

/** Layer label used in human output. */
export function layerLabel(layer: ConfigLayerName | undefined): string {
  return layer ?? '-';
}
