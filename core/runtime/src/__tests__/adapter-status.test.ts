/**
 * @module @kb-labs/core-runtime/__tests__/adapter-status
 *
 * Behavioural tests for the adapter status registry. The registry is a
 * global singleton, so every test starts with `resetAdapterStatus()` for
 * isolation.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ADAPTER_CONFIG_KEYS } from '../config.js';
import {
  getAdapterStatus,
  getAdapterStatusFor,
  getAdapterStatusRegistry,
  resetAdapterStatus,
  type AdapterSlotStatus,
} from '../adapter-status.js';

function row(slot: string, overrides: Partial<AdapterSlotStatus> = {}): AdapterSlotStatus {
  return {
    slot: slot as AdapterSlotStatus['slot'],
    mode: 'real',
    implementation: '@kb-labs/test-adapter',
    recordedAt: new Date().toISOString(),
    ...overrides,
  };
}

const adapterStatusProjectionCases: Array<{ slot: string; key: string | undefined; projection: 'package' | 'composite' }> =
  Object.entries(ADAPTER_CONFIG_KEYS).reduce((cases, [slot, mapping]) => {
    if (mapping.keys.length === 0) {cases.push({ slot, key: undefined, projection: mapping.projection });}
    for (const key of mapping.keys) {cases.push({ slot, key, projection: mapping.projection });}
    return cases;
  }, [] as Array<{ slot: string; key: string | undefined; projection: 'package' | 'composite' }>);

describe('adapter-status registry', () => {
  beforeEach(() => {
    resetAdapterStatus();
  });

  describe('record() / list()', () => {
    it('returns empty list before any record is written', () => {
      expect(getAdapterStatus()).toEqual([]);
    });

    it('writes a status and reads it back via list()', () => {
      const reg = getAdapterStatusRegistry();
      reg.record(row('cache'), {});
      const list = getAdapterStatus();
      expect(list).toHaveLength(1);
      expect(list[0]!.slot).toBe('cache');
    });

    it.each(adapterStatusProjectionCases)('projects $slot for doctor from mapped config key $key', ({ slot, key, projection }) => {
      const reg = getAdapterStatusRegistry();
      const configured = '@kb-labs/adapters-selected';
      const host = projection === 'composite' ? 'HybridLogReader' : '@kb-labs/adapters-stale';
      reg.record(row(slot, {
        implementation: host,
        configuredPackage: host,
      }), key === undefined ? {} : { [key]: configured });

      const expectedImplementation = projection === 'package' && key !== undefined ? configured : host;
      const expectedConfiguredPackage = projection === 'package' && key !== undefined ? configured : host;
      expect(getAdapterStatusFor(slot as AdapterSlotStatus['slot'])).toMatchObject({
        implementation: expectedImplementation,
        configuredPackage: expectedConfiguredPackage,
        mode: 'real',
      });
    });

    it('overwrites a slot when record() is called twice', () => {
      const reg = getAdapterStatusRegistry();
      reg.record(row('cache', { mode: 'inmemory', implementation: 'InMemoryCache' }), {});
      reg.record(row('cache', { mode: 'real', implementation: '@kb-labs/adapters-redis' }), {});
      expect(getAdapterStatus()).toHaveLength(1);
      expect(getAdapterStatusFor('cache')!.mode).toBe('real');
      expect(getAdapterStatusFor('cache')!.implementation).toBe('@kb-labs/adapters-redis');
    });
  });

  describe('get() / getAdapterStatusFor()', () => {
    it('returns undefined for unknown slot', () => {
      expect(getAdapterStatusFor('cache')).toBeUndefined();
    });

    it('returns the exact row that was recorded', () => {
      const reg = getAdapterStatusRegistry();
      const status = row('llm', {
        mode: 'noop',
        implementation: 'NoOpLLM',
        reason: 'not-configured',
      });
      reg.record(status, {});
      expect(getAdapterStatusFor('llm')).toEqual(status);
    });
  });

  describe('resetAdapterStatus()', () => {
    it('clears all records', () => {
      const reg = getAdapterStatusRegistry();
      reg.record(row('cache'), {});
      reg.record(row('llm', { mode: 'noop', implementation: 'NoOpLLM' }), {});
      expect(getAdapterStatus()).toHaveLength(2);
      resetAdapterStatus();
      expect(getAdapterStatus()).toEqual([]);
    });
  });

  describe('singleton behaviour', () => {
    it('multiple getAdapterStatusRegistry() calls return views on the same store', () => {
      getAdapterStatusRegistry().record(row('cache'), {});
      // Different handle, same backing store.
      const list = getAdapterStatusRegistry().list();
      expect(list).toHaveLength(1);
    });

    it('survives across distinct callers via globalThis singleton', () => {
      getAdapterStatusRegistry().record(row('storage'), {});
      // Re-import equivalent via top-level helpers
      expect(getAdapterStatusFor('storage')).toBeDefined();
    });
  });

  describe('mode types are exhaustive in practice', () => {
    it('accepts each documented mode', () => {
      const reg = getAdapterStatusRegistry();
      reg.record(row('cache', { mode: 'real' }), {});
      reg.record(row('llm', { mode: 'noop' }), {});
      reg.record(row('documentDatabase', { mode: 'inmemory' }), {});
      expect(getAdapterStatusFor('cache')!.mode).toBe('real');
      expect(getAdapterStatusFor('llm')!.mode).toBe('noop');
      expect(getAdapterStatusFor('documentDatabase')!.mode).toBe('inmemory');
    });
  });
});
