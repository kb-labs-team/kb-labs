/**
 * @module @kb-labs/core-runtime/adapter-status
 *
 * Adapter status registry. Records the mode (real / inmemory / noop) of
 * every platform adapter slot picked up by `initPlatform()`, so operators
 * can inspect what the platform is actually running with.
 *
 * The loader writes to this registry once per slot during startup;
 * `getAdapterStatus()` is the read API. Plugins consume the same data via
 * the `useAdapterStatus()` SDK hook; the gateway publishes it at
 * `/health/adapters`; `kb-create doctor` polls that endpoint for the
 * installed-platform operator report.
 *
 * Storage: global singleton on `globalThis` via `Symbol.for(...)`, the same
 * cross-realm pattern used by the platform container singleton in
 * `container.ts`. `resetAdapterStatus()` clears it and is called from
 * `resetPlatform()` so test runs stay hermetic.
 */

import type { AdapterSlot } from '@kb-labs/core-platform';
import { configuredAdapterForSlot, projectEffectiveAdapterImplementation, type AdapterConfigValues } from './default-adapters.js';

/**
 * Whether the slot is backed by a real configured adapter, an honest
 * in-process implementation, or a fail-loud NoOp stub.
 */
export type AdapterMode = 'real' | 'inmemory' | 'noop' | 'degraded';

/**
 * Why the slot ended up in its current mode. Only meaningful when
 * `mode !== 'real'`.
 */
export type AdapterStatusReason = 'not-configured' | 'load-failed';

export interface AdapterSlotStatus {
  /** Slot key, e.g. 'llm', 'cache', 'documentDatabase'. */
  slot: AdapterSlot;
  /** Real / inmemory / noop / degraded. */
  mode: AdapterMode;
  /**
   * Implementation identifier — package id for real adapters
   * (e.g. `'@kb-labs/adapters-sqlite'`), class name for fallbacks
   * (e.g. `'InMemoryCache'`, `'NoOpLLM'`).
   */
  implementation: string;
  /**
   * What the user wrote in the platform config key mapped to this slot, if anything.
   * Useful for diagnostics: "configured but fell back" should never happen
   * by policy, but recording the configured value makes audits cheap.
   */
  configuredPackage?: string;
  /** Why `mode !== 'real'`. */
  reason?: AdapterStatusReason;
  /** Correlation ID for the single startup diagnostic that recorded this failure. */
  correlationId?: string;
  /** Copy-ready package repair command for a degraded configured slot. */
  action?: { id: string; label: string; command: string };
  /** ISO timestamp of the record. */
  recordedAt: string;
}

/**
 * Mutable view of the registry — only the loader should call `record()`.
 */
export interface AdapterStatusRegistry {
  record(status: AdapterSlotStatus, adapters: AdapterConfigValues): void;
  get(slot: AdapterSlot): AdapterSlotStatus | undefined;
  list(): AdapterSlotStatus[];
  clear(): void;
}

const REGISTRY_KEY = Symbol.for('kb.adapter-status');

type GlobalWithRegistry = typeof globalThis & {
  [REGISTRY_KEY]?: Map<AdapterSlot, AdapterSlotStatus>;
};

function getStore(): Map<AdapterSlot, AdapterSlotStatus> {
  const g = globalThis as GlobalWithRegistry;
  let store = g[REGISTRY_KEY];
  if (!store) {
    store = new Map();
    g[REGISTRY_KEY] = store;
  }
  return store;
}

/**
 * Read-write handle on the global registry. Loader uses `record()`;
 * everything else should prefer `getAdapterStatus()` / `getAdapterStatusFor()`.
 */
export function getAdapterStatusRegistry(): AdapterStatusRegistry {
  const store = getStore();
  return {
    record(status: AdapterSlotStatus, adapters: AdapterConfigValues): void {
      const configuredPackage = configuredAdapterForSlot(status.slot, adapters)?.value;
      const configuredPath = typeof configuredPackage === 'string'
        ? configuredPackage
        : Array.isArray(configuredPackage) ? configuredPackage[0] : undefined;
      store.set(status.slot, {
        ...status,
        implementation: projectEffectiveAdapterImplementation(
          status.slot,
          adapters,
          status.implementation,
        ) ?? status.implementation,
        ...(configuredPath !== undefined ? { configuredPackage: configuredPath } : {}),
      });
    },
    get(slot: AdapterSlot): AdapterSlotStatus | undefined {
      return store.get(slot);
    },
    list(): AdapterSlotStatus[] {
      return [...store.values()];
    },
    clear(): void {
      store.clear();
    },
  };
}

/**
 * Snapshot of the current adapter status across all slots. Empty array
 * means `initPlatform()` has not run yet (or `resetAdapterStatus()` was
 * called and no init has happened since).
 */
export function getAdapterStatus(): AdapterSlotStatus[] {
  return getAdapterStatusRegistry().list();
}

/**
 * Look up the status of a single slot.
 */
export function getAdapterStatusFor(slot: AdapterSlot): AdapterSlotStatus | undefined {
  return getAdapterStatusRegistry().get(slot);
}

/**
 * Clear all recorded statuses. Called from `resetPlatform()` so tests
 * that re-run `initPlatform()` see fresh state, never stale records
 * from a previous test.
 */
export function resetAdapterStatus(): void {
  getAdapterStatusRegistry().clear();
}
