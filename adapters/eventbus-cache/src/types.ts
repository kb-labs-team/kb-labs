/**
 * @module @kb-labs/adapters-eventbus-cache/types
 * Type definitions for Cache-backed EventBus adapter.
 */

import type { ICache } from '@kb-labs/sdk/adapters';

/**
 * Dependencies for Cache-backed EventBus adapter.
 * Matches manifest.requires.adapters: [{ id: 'cache', alias: 'cache' }]
 */
export interface CacheEventBusDeps {
  cache: ICache;
}

/**
 * Configuration for Cache-backed EventBus adapter.
 */
export interface CacheEventBusConfig {
  /** Polling interval in milliseconds (default: 1000) */
  pollIntervalMs?: number;
  /** Event TTL in milliseconds (default: 24 hours) */
  eventTtlMs?: number;
  /** Key prefix for cache keys (default: "eventbus:") */
  keyPrefix?: string;
}

/**
 * Stored event structure in cache.
 */
export interface StoredEvent<T = unknown> {
  /** Adapter-local ordering key for events written with an equal timestamp. */
  sequence?: string;
  /** Unique event ID */
  id: string;
  /** Event topic */
  topic: string;
  /** Event payload */
  data: T;
  /** Event timestamp (ms since epoch) */
  timestamp: number;
}

/**
 * Internal subscription tracking.
 */
export interface Subscription {
  /** Topic name */
  topic: string;
  /** Event handler function */
  handler: (event: unknown) => Promise<void>;
  /** Polling timer reference */
  timer: ReturnType<typeof setInterval> | null;
  /** Unique subscriber ID */
  subscriberId: string;
  /** Last processed event timestamp */
  lastTimestamp: number;
  /** IDs of events already delivered (for dedup within same timestamp) */
  seenIds: Set<string>;
}
