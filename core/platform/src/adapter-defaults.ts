/**
 * @module @kb-labs/core-platform/adapter-defaults
 *
 * Per-slot default fallback policy for the platform adapter pipeline.
 *
 * After installed adapter manifests have supplied any `defaultFor` package,
 * the runtime consults this table for slots that remain unconfigured:
 *
 * - `'inmemory'` — instantiate a working, honest in-process implementation
 *   from `@kb-labs/core-platform/inmemory`. Operations behave correctly;
 *   data lives only for the lifetime of the process.
 *
 * - `'noop'` — instantiate a stub that throws `AdapterUnavailableError` on
 *   every functional operation. Used for slots where an honest fallback is
 *   impossible (e.g. LLM — no way to fake model output without lying to
 *   the caller).
 *
 * **A configured adapter that fails to load is NEVER auto-degraded** —
 * that's a fail-fast condition handled by the loader, not this table.
 * `preferInstalledDefault` marks slots that must resolve a local installed
 * provider before any fallback is considered on an installed platform.
 *
 * The `satisfies Record<AdapterSlot, ...>` clause is intentional: if a new
 * slot is added to `IPlatformAdapters` without a corresponding entry here,
 * this file fails to compile. That keeps the table in sync with the
 * adapter surface without manual review.
 */

import type { IPluginAdapters } from './platform-adapters.js';

/**
 * Union of every plugin-visible adapter slot.
 *
 * Covers IPluginAdapters only — platform-only adapters (e.g. serviceTransport)
 * are intentionally excluded: they have no inmemory/noop fallback and are never
 * managed by the plugin runtime.
 */
export type AdapterSlot = keyof IPluginAdapters;

/**
 * Default fallback choice when neither config nor installed manifests provide a slot.
 *
 * - `'inmemory'` — InMemory implementation will be instantiated.
 * - `'noop'`     — NoOp stub that throws `AdapterUnavailableError`.
 */
export type DefaultFallbackMode = 'inmemory' | 'noop';

export interface AdapterDefault {
  defaultFallback: DefaultFallbackMode;
  /** Identifier shown by `kb adapter list` when no package overrides this slot. */
  implementation: string;
  /** Runtime must resolve an installed manifest default before using any fallback. */
  preferInstalledDefault?: boolean;
}

/**
 * Default fallback policy per slot.
 *
 * Adding a new slot to `IPlatformAdapters` without adding an entry here
 * triggers a compile-time error from the `satisfies` clause.
 */
export const ADAPTER_DEFAULTS = {
  // ── Honest in-memory implementations (work in single-process) ────────────
  logger:           { defaultFallback: 'inmemory', implementation: 'ConsoleLogger', preferInstalledDefault: true },
  cache:            { defaultFallback: 'inmemory', implementation: 'InMemoryCache', preferInstalledDefault: true },
  storage:          { defaultFallback: 'inmemory', implementation: 'InMemoryStorage', preferInstalledDefault: true },
  eventBus:         { defaultFallback: 'inmemory', implementation: 'InMemoryEventBus', preferInstalledDefault: true },
  documentDatabase: { defaultFallback: 'inmemory', implementation: 'InMemoryDocumentDatabase', preferInstalledDefault: true },
  kvStore:          { defaultFallback: 'inmemory', implementation: 'InMemoryKVStore', preferInstalledDefault: true },
  invoke:           { defaultFallback: 'inmemory', implementation: 'InMemoryInvoke' },
  artifacts:        { defaultFallback: 'inmemory', implementation: 'InMemoryArtifacts' },
  config:           { defaultFallback: 'inmemory', implementation: 'InMemoryConfig' },
  analytics:        { defaultFallback: 'inmemory', implementation: 'InMemoryAnalyticsBuffer', preferInstalledDefault: true },
  notifier:         { defaultFallback: 'inmemory', implementation: 'InMemoryNotifier' },

  // ── No honest fallback possible — throw on use ───────────────────────────
  llm:              { defaultFallback: 'noop', implementation: 'NoOpLLM', preferInstalledDefault: false },
  embeddings:       { defaultFallback: 'noop', implementation: 'NoOpEmbeddings', preferInstalledDefault: true },
  vectorStore:      { defaultFallback: 'noop', implementation: 'unavailable', preferInstalledDefault: true },
  logs:             { defaultFallback: 'noop', implementation: 'unavailable', preferInstalledDefault: true },
  snapshotManager:  { defaultFallback: 'noop', implementation: 'unavailable' },
} as const satisfies Record<AdapterSlot, AdapterDefault>;
