/** Resolve manifest-declared built-in adapter defaults for installed platforms. */

import { findDiscoveredAdapter, type DiscoveredAdapter } from './discover-adapters.js';
import { resolveRuntimeStatePath } from '@kb-labs/core-project-registry';
import { ADAPTER_DEFAULTS, type AdapterSlot } from '@kb-labs/core-platform';
import { ADAPTER_CONFIG_KEYS, type AdapterValue, type AdaptersConfig } from './config.js';

export interface ResolvedAdapterConfig {
  adapters: AdaptersConfig;
  adapterOptions: Record<string, unknown>;
}

export type AdapterConfigValues = Readonly<Partial<AdaptersConfig>> | Readonly<Record<string, AdapterValue | undefined>>;

export interface ConfiguredAdapterValue {
  key: keyof AdaptersConfig;
  value: AdapterValue | undefined;
}

/** Resolve the platform config key and value that configure a runtime adapter slot. */
export function configuredAdapterForSlot(
  slot: string,
  adapters: AdapterConfigValues,
): ConfiguredAdapterValue | undefined {
  const slotMapping = ADAPTER_CONFIG_KEYS[slot as AdapterSlot];
  if (slotMapping?.projection === 'composite') {return undefined;}
  const aliasKey = Object.values(ADAPTER_CONFIG_KEYS)
    .flatMap((mapping) => mapping.keys)
    .find((key) => key === slot);
  const configKeys = slotMapping?.keys ?? (aliasKey ? [aliasKey] : undefined);
  if (!configKeys || configKeys.length === 0) {return undefined;}
  const key = configKeys.find((candidate) => Reflect.get(adapters, candidate) !== undefined) ??
    configKeys.find((candidate) => candidate === slot) ?? configKeys[0];
  if (!key) {return undefined;}
  return { key, value: Reflect.get(adapters, key) as AdapterValue | undefined };
}

/** Resolve the selected package identity for a slot over its host observation. */
export function projectEffectiveAdapterImplementation(
  slot: string,
  adapters: AdapterConfigValues,
  hostImplementation?: string,
  fallbackImplementation?: string | null,
): string | null {
  const configured = configuredAdapterForSlot(slot, adapters)?.value;
  const configuredPath = typeof configured === 'string'
    ? configured
    : Array.isArray(configured) && typeof configured[0] === 'string'
      ? configured[0]
      : undefined;
  const selected = configuredPath ? adapterPackageName(configuredPath) : undefined;
  if (selected && hostImplementation !== undefined && hostImplementation !== 'unavailable' &&
    adapterPackageRoot(hostImplementation) === adapterPackageRoot(selected)) {
    return hostImplementation;
  }
  if (selected) {return selected;}
  if (hostImplementation !== undefined) {
    return hostImplementation === 'unavailable' ? null : hostImplementation;
  }
  if (fallbackImplementation !== undefined) {return fallbackImplementation;}
  const fallback = ADAPTER_DEFAULTS[slot as AdapterSlot]?.implementation;
  return fallback === undefined || fallback === 'unavailable' ? null : fallback;
}

export function adapterPackageName(spec: string): string {
  const separator = spec.lastIndexOf('@');
  return separator > spec.indexOf('/') ? spec.slice(0, separator) : spec;
}

export function adapterPackageRoot(spec: string): string {
  const name = adapterPackageName(spec);
  const segments = name.split('/');
  return name.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0] ?? name;
}

export function resolveDiscoveredAdapterDefaults(
  config: ResolvedAdapterConfig,
  discovered: ReadonlyMap<string, DiscoveredAdapter>,
  projectRoot: string,
): ResolvedAdapterConfig {
  const adapters = { ...config.adapters };
  const adapterOptions = { ...config.adapterOptions };
  const packages = new Map<string, DiscoveredAdapter>();
  for (const adapter of discovered.values()) {
    packages.set(adapter.packageName, adapter);
  }

  const defaults = new Map<string, DiscoveredAdapter[]>();
  for (const adapter of packages.values()) {
    const manifest = adapter.module.manifest;
    if (!manifest || typeof manifest !== 'object') {continue;}
    const hasUnprovidedStructure = Object.values(manifest.configSchema ?? {}).some(option =>
      option.required && option.default === undefined && !(option.secret && option.env),
    );
    if (hasUnprovidedStructure) {continue;}
    const defaultFor = manifest.defaultFor ?? {};
    for (const slot of Object.keys(defaultFor)) {
      const config = configuredAdapterForSlot(slot, adapters);
      if (!config) {
        throw new Error(defaultMappingError(adapter.packageName, slot));
      }
      if (config.value) {continue;}
      const candidates = defaults.get(slot) ?? [];
      candidates.push(adapter);
      defaults.set(slot, candidates);
    }
  }

  for (const [slot, candidates] of defaults) {
    if (configuredAdapterForSlot(slot, adapters)?.value) {continue;}
    if (candidates.length !== 1) {
      throw new Error(`Multiple installed adapters declare ${slot} as a default: ${candidates.map(candidate => candidate.packageName).join(', ')}. Bind one with \`kb adapter bind ${slot} <package>\`.`);
    }
    const adapter = candidates[0];
    if (!adapter) {continue;}
    const config = configuredAdapterForSlot(slot, adapters);
    if (!config) {throw new Error(defaultMappingError(adapter.packageName, slot));}
    const manifest = adapter.module.manifest;
    const entrypoint = manifest.defaultFor?.[slot];
    if (!entrypoint) {
      throw new Error(`Adapter ${adapter.packageName} declares default slot ${slot} without an entry point. Add the module path to its adapter manifest and rebuild it with \`corepack pnpm --filter ${adapter.packageName} build\`.`);
    }
    const slotManifest = adapter.entrypointManifests?.[entrypoint.join('/')];
    if (!slotManifest) {
      throw new Error(`Adapter ${adapter.packageName} default entry point for ${slot} has no loaded manifest.`);
    }
    adapters[config.key] = [adapter.packageName, ...entrypoint].join('/');
    adapterOptions[config.key] = {
      ...declaredDefaults(slotManifest, projectRoot),
      ...asRecord(adapterOptions[config.key]),
    };
  }

  for (const [configKey, configured] of Object.entries(adapters)) {
    const adapterPath = Array.isArray(configured) ? configured[0] : configured;
    if (typeof adapterPath !== 'string') {continue;}
    const resolved = findDiscoveredAdapter(adapterPath, discovered);
    const adapter = resolved?.adapter;
    if (!adapter) {continue;}
    const manifest = adapter.entrypointManifests?.[resolved.subpath] ?? adapter.module.manifest;
    adapterOptions[configKey] = {
      ...declaredDefaults(manifest, projectRoot),
      ...asRecord(adapterOptions[configKey]),
    };
  }

  return { adapters, adapterOptions };

}

function defaultMappingError(packageName: string, slot: string): string {
  return `Adapter ${packageName} declares ${slot} as a default, but that slot has no package config key. ` +
    `Remove the defaultFor entry from its manifest, then rebuild it with \`corepack pnpm --filter ${packageName} build\`.`;
}

function declaredDefaults(
  manifest: DiscoveredAdapter['module']['manifest'],
  projectRoot: string,
): Record<string, unknown> {
  if (!manifest || typeof manifest !== 'object') {return {};}
  const result: Record<string, unknown> = {};
  for (const [key, option] of Object.entries(manifest.configSchema ?? {})) {
    if (option.defaultPath) {
      result[key] = resolveRuntimeStatePath(projectRoot, option.defaultPath.segments);
    } else if (option.default !== undefined) {
      result[key] = option.default;
    }
  }
  return result;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
