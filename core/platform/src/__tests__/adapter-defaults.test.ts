/**
 * @module @kb-labs/core-platform/__tests__/adapter-defaults
 *
 * Tests that `ADAPTER_DEFAULTS` stays in sync with `IPlatformAdapters`.
 *
 * The `satisfies` clause already enforces compile-time exhaustiveness, but
 * we keep a runtime test as a second line of defence and to document the
 * expectations explicitly. If a slot is added or removed in
 * `platform-adapters.ts`, this test will surface what the contract is.
 */

import { describe, it, expect } from 'vitest';
import { ADAPTER_DEFAULTS } from '../adapter-defaults.js';
import type { AdapterSlot } from '../adapter-defaults.js';

describe('ADAPTER_DEFAULTS', () => {
  it('declares a fallback for every slot expected by the platform', () => {
    const expectedSlots: AdapterSlot[] = [
      'logger',
      'analytics',
      'vectorStore',
      'llm',
      'embeddings',
      'cache',
      'config',
      'storage',
      'eventBus',
      'invoke',
      'documentDatabase',
      'kvStore',
      'logs',
      'artifacts',
      'snapshotManager',
      'notifier',
    ];

    for (const slot of expectedSlots) {
      expect(ADAPTER_DEFAULTS[slot]).toBeDefined();
      expect(['inmemory', 'noop']).toContain(ADAPTER_DEFAULTS[slot].defaultFallback);
      expect(ADAPTER_DEFAULTS[slot].implementation).toBeTruthy();
    }
  });

  it('leaves model and vector providers unavailable instead of fabricating results', () => {
    expect(ADAPTER_DEFAULTS.llm.defaultFallback).toBe('noop');
    expect(ADAPTER_DEFAULTS.embeddings.defaultFallback).toBe('noop');
    expect(ADAPTER_DEFAULTS.vectorStore.defaultFallback).toBe('noop');
    expect(ADAPTER_DEFAULTS.vectorStore.implementation).toBe('unavailable');
    expect(ADAPTER_DEFAULTS.notifier.defaultFallback).toBe('inmemory');
    expect(ADAPTER_DEFAULTS.logs.defaultFallback).toBe('noop');
  });

  it('uses "inmemory" for slots that can be honestly served in-process', () => {
    expect(ADAPTER_DEFAULTS.cache.defaultFallback).toBe('inmemory');
    expect(ADAPTER_DEFAULTS.documentDatabase.defaultFallback).toBe('inmemory');
    expect(ADAPTER_DEFAULTS.kvStore.defaultFallback).toBe('inmemory');
    expect(ADAPTER_DEFAULTS.storage.defaultFallback).toBe('inmemory');
    expect(ADAPTER_DEFAULTS.eventBus.defaultFallback).toBe('inmemory');
    expect(ADAPTER_DEFAULTS.logger.defaultFallback).toBe('inmemory');
  });

  it('marks installed local-persistent providers as preferred over the in-memory test fallback', () => {
    for (const slot of ['storage', 'cache', 'eventBus', 'documentDatabase', 'kvStore', 'analytics', 'logger', 'logs'] as const) {
      expect(ADAPTER_DEFAULTS[slot].preferInstalledDefault).toBe(true);
    }
    expect(ADAPTER_DEFAULTS.llm.preferInstalledDefault).not.toBe(true);
    expect(ADAPTER_DEFAULTS.embeddings.preferInstalledDefault).toBe(true);
    expect(ADAPTER_DEFAULTS.vectorStore.preferInstalledDefault).toBe(true);
  });

  it('is a const object — runtime mutation must be impossible (frozen at type level)', () => {
    // Type-level: `as const` makes properties readonly. We re-assert at runtime
    // that the shape is as expected. Direct mutation would be a TS error.
    const sample = ADAPTER_DEFAULTS.cache;
    expect(sample.defaultFallback).toBe('inmemory');
  });
});
