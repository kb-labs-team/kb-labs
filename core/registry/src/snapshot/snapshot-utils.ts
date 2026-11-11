/**
 * @module @kb-labs/core-registry/snapshot/snapshot-utils
 * Snapshot checksum and serialization utilities.
 */

import { createHash } from 'node:crypto';
import type { SnapshotWithoutIntegrity } from '@kb-labs/plugin-contracts';

export const SNAPSHOT_CHECKSUM_ALGORITHM = 'sha256';

export function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Stable JSON stringify for deterministic checksums.
 * Sorts object keys and filters undefined values.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => stableStringify(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, val]) => val !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`).join(',')}}`;
}

export function computeSnapshotChecksum(snapshot: SnapshotWithoutIntegrity): string {
  return createHash(SNAPSHOT_CHECKSUM_ALGORITHM).update(stableStringify(snapshot)).digest('hex');
}

export function safeParseInt(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {return Math.floor(value);}
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {return parsed;}
  }
  return 0;
}
