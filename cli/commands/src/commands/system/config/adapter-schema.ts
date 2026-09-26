/**
 * Validation of `platform.adapterOptions.<adapter>` against the adapter's
 * manifest `configSchema` (ADR-0047: adapters already declare their options).
 *
 * The manifest `configSchema` is a descriptive map (`type`, `enum`, ...) that
 * is not guaranteed to list every option an adapter accepts, so the check is
 * deliberately narrow: only options the manifest DECLARES are type/enum
 * checked, unknown options pass, and `required` is not enforced (a project
 * layer may set only some of the options). When the adapter package or its
 * manifest cannot be found the check is skipped and the write is validated by
 * the platform schema alone.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { isEnvReference, type ConfigIssue } from '@kb-labs/core-config';

export interface ManifestFieldSchema {
  type?: string;
  enum?: unknown[];
}

export type ManifestConfigSchema = Record<string, ManifestFieldSchema>;

interface PackageJson {
  main?: string;
  exports?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** `@scope/pkg/sub/path` -> `{ name: '@scope/pkg', subpath: './sub/path' }`. */
export function splitPackageSpecifier(spec: string): { name: string; subpath: string } {
  const parts = spec.split('/');
  const nameLength = spec.startsWith('@') ? 2 : 1;
  const name = parts.slice(0, nameLength).join('/');
  const rest = parts.slice(nameLength).join('/');
  return { name, subpath: rest ? `./${rest}` : '.' };
}

function exportTarget(entry: unknown): string | undefined {
  if (typeof entry === 'string') {
    return entry;
  }
  if (isRecord(entry)) {
    for (const condition of ['import', 'default', 'node', 'require']) {
      const target = exportTarget(entry[condition]);
      if (target) {
        return target;
      }
    }
  }
  return undefined;
}

/** Absolute path of the module a package specifier resolves to, looked up under the given roots. */
export function resolveAdapterModule(spec: string, roots: readonly string[]): string | undefined {
  const { name, subpath } = splitPackageSpecifier(spec);
  for (const root of roots) {
    const pkgDir = path.join(root, 'node_modules', name);
    const pkgJsonPath = path.join(pkgDir, 'package.json');
    if (!existsSync(pkgJsonPath)) {
      continue;
    }
    let pkg: PackageJson;
    try {
      pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as PackageJson;
    } catch {
      continue;
    }
    const exportsField = pkg.exports;
    let target: string | undefined;
    if (isRecord(exportsField) && Object.keys(exportsField).some((key) => key.startsWith('.'))) {
      target = exportTarget(exportsField[subpath]);
    } else if (subpath === '.') {
      target = exportTarget(exportsField) ?? pkg.main ?? 'index.js';
    }
    if (target) {
      const full = path.resolve(pkgDir, target);
      if (existsSync(full)) {
        return full;
      }
    }
  }
  return undefined;
}

/** The manifest `configSchema` of an adapter package, or `undefined` when unavailable. */
export async function loadAdapterConfigSchema(
  spec: string,
  roots: readonly string[],
): Promise<ManifestConfigSchema | undefined> {
  const modulePath = resolveAdapterModule(spec, roots);
  if (!modulePath) {
    return undefined;
  }
  try {
    const mod = (await import(pathToFileURL(modulePath).href)) as Record<string, unknown>;
    const fromDefault = isRecord(mod.default) ? mod.default.manifest : undefined;
    const manifest = mod.manifest ?? fromDefault;
    if (isRecord(manifest) && isRecord(manifest.configSchema)) {
      return manifest.configSchema as ManifestConfigSchema;
    }
  } catch {
    // The adapter cannot be imported here; fall back to the platform schema.
  }
  return undefined;
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isRecord(value);
    default:
      return true;
  }
}

/** Check the declared options of `options` against a manifest `configSchema`. */
export function validateAdapterOptions(
  basePath: string,
  options: Record<string, unknown>,
  schema: ManifestConfigSchema,
): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  for (const [key, field] of Object.entries(schema)) {
    if (!Object.prototype.hasOwnProperty.call(options, key)) {
      continue;
    }
    const value = options[key];
    const fieldPath = `${basePath}.${key}`;
    // `${ENV_VAR}` references resolve at load time and may stand for any type.
    if (isEnvReference(value)) {
      continue;
    }
    if (field.type && !matchesType(field.type, value)) {
      issues.push({ path: fieldPath, message: `Expected ${field.type}` });
    } else if (field.enum && !field.enum.includes(value)) {
      issues.push({ path: fieldPath, message: `Expected one of: ${field.enum.map(String).join(', ')}` });
    }
  }
  return issues;
}

function adapterSpecFor(name: string, ...adapterMaps: unknown[]): string | undefined {
  for (const adapters of adapterMaps) {
    if (!isRecord(adapters)) {
      continue;
    }
    const value = adapters[name];
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === 'string' && first !== '') {
      return first;
    }
  }
  return undefined;
}

function optionsHolder(keyPath: readonly string[]): { name: string; basePath: string } | undefined {
  // Paths: platform.adapterOptions.<name>[...]  or  adapterOptions.<name>[...]
  const at = keyPath[0] === 'platform' ? 1 : 0;
  if (keyPath[at] !== 'adapterOptions' || keyPath[at + 1] === undefined) {
    return undefined;
  }
  const name = keyPath[at + 1]!;
  const scope = at === 1 ? ['platform', 'adapterOptions', name] : ['adapterOptions', name];
  return { name, basePath: scope.join('.') };
}

export interface AdapterOptionsValidatorInput {
  /** Roots searched for `node_modules/<adapter>` (platform first, then project). */
  roots: readonly string[];
  /** `platform.adapters` of the effective config, used when the edited file does not bind the adapter itself. */
  effectiveAdapters?: unknown;
}

/**
 * Build the `validate` hook for `setUserConfigValue`: when the edited key lives
 * under `adapterOptions.<name>`, validate that adapter's options against its
 * manifest `configSchema`.
 */
export function createAdapterOptionsValidator(
  keyPath: readonly string[],
  input: AdapterOptionsValidatorInput,
): ((document: Record<string, unknown>) => Promise<ConfigIssue[]>) | undefined {
  const target = optionsHolder(keyPath);
  if (!target) {
    return undefined;
  }
  const { name, basePath } = target;
  let cachedSchema: Promise<ManifestConfigSchema | undefined> | undefined;

  return async (document) => {
    const platform = isRecord(document.platform) ? document.platform : undefined;
    const optionsRoot = keyPath[0] === 'platform' ? platform?.adapterOptions : document.adapterOptions;
    const options = isRecord(optionsRoot) ? optionsRoot[name] : undefined;
    if (!isRecord(options)) {
      return [];
    }
    const spec = adapterSpecFor(name, platform?.adapters, input.effectiveAdapters);
    if (!spec) {
      return [];
    }
    cachedSchema ??= loadAdapterConfigSchema(spec, input.roots);
    const schema = await cachedSchema;
    return schema ? validateAdapterOptions(basePath, options, schema) : [];
  };
}
