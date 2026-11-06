/**
 * @module @kb-labs/core-registry/state/plugin-state
 * Plugin state management backed by .kb/marketplace.lock.
 * The `enabled` flag lives in marketplace.lock — single source of truth.
 * Moved from @kb-labs/cli-commands/registry/plugins-state.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  enablePlugin as enableInLock,
  disablePlugin as disableInLock,
} from '@kb-labs/core-discovery';

export interface PluginState {
  enabled: string[];
  disabled: string[];
  linked: string[];
  permissions: Record<string, string[]>;
  integrity: Record<string, string>;
  crashes: Record<string, number>;
  lastUpdated: number;
}

const DEFAULT_STATE: PluginState = {
  enabled: [],
  disabled: [],
  linked: [],
  permissions: {},
  integrity: {},
  crashes: {},
  lastUpdated: Date.now(),
};

export function getPluginsStatePath(root: string): string {
  return path.join(root, '.kb', 'plugins.json');
}

export async function loadPluginsState(root: string): Promise<PluginState> {
  try {
    const content = await fs.readFile(getPluginsStatePath(root), 'utf8');
    const state = JSON.parse(content) as Partial<PluginState>;
    return {
      ...DEFAULT_STATE,
      ...state,
      enabled: state.enabled || [],
      disabled: state.disabled || [],
      linked: state.linked || [],
      permissions: state.permissions || {},
      integrity: state.integrity || {},
      crashes: state.crashes || {},
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export async function savePluginsState(root: string, state: PluginState): Promise<void> {
  const statePath = getPluginsStatePath(root);
  const dir = path.dirname(statePath);
  await fs.mkdir(dir, { recursive: true });

  const toWrite = { ...state, lastUpdated: Date.now() };
  const tmpPath = `${statePath}.tmp.${process.pid}`;
  await fs.writeFile(tmpPath, JSON.stringify(toWrite, null, 2), 'utf8');
  await fs.rename(tmpPath, statePath);
}

export function isPluginEnabled(state: PluginState, packageName: string, defaultEnabled = false): boolean {
  if (state.disabled.includes(packageName)) {return false;}
  if (state.enabled.includes(packageName)) {return true;}
  return defaultEnabled;
}

/**
 * Enable a plugin — sets `enabled: true` in marketplace.lock.
 * Throws if the plugin is not registered in the lock.
 */
export async function enablePlugin(root: string, packageName: string): Promise<void> {
  const ok = await enableInLock(root, packageName);
  if (!ok) {
    throw new Error(`Plugin "${packageName}" is not registered in marketplace.lock — run "kb marketplace install ${packageName}" first`);
  }
}

/**
 * Disable a plugin — sets `enabled: false` in marketplace.lock.
 * Throws if the plugin is not registered in the lock.
 */
export async function disablePlugin(root: string, packageName: string): Promise<void> {
  const ok = await disableInLock(root, packageName);
  if (!ok) {
    throw new Error(`Plugin "${packageName}" is not registered in marketplace.lock — run "kb marketplace install ${packageName}" first`);
  }
}

export async function recordCrash(root: string, packageName: string): Promise<void> {
  const state = await loadPluginsState(root);
  state.crashes[packageName] = (state.crashes[packageName] || 0) + 1;
  if (state.crashes[packageName]! >= 3 && !state.disabled.includes(packageName)) {
    state.disabled.push(packageName);
  }
  await savePluginsState(root, state);
}
