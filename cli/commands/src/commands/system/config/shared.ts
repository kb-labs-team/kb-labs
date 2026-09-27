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
  resolveUserConfigFile,
} from '@kb-labs/core-config';
import { loadPlatformConfig } from '@kb-labs/core-runtime';
import type { ErrorEnvelope } from '@kb-labs/core-platform';
import type { PluginContextV3 } from '@kb-labs/plugin-contracts';

export const CONFIG_SCOPES = ['platform', 'project'] as const;
export type ConfigScope = (typeof CONFIG_SCOPES)[number];

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

// ── Error envelope rendering ─────────────────────────────────────────────────
// `configErrorEnvelope` (the ConfigWriteError -> ErrorEnvelope mapping) now
// lives in `@kb-labs/core-config` (ADR-0049), shared with the host's
// `/api/v1/adapters` API; only terminal rendering stays here.

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
