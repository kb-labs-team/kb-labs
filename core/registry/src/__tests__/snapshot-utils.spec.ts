import { describe, it, expect } from 'vitest';
import {
  stableStringify,
  computeSnapshotChecksum,
  cloneValue,
  safeParseInt,
} from '../snapshot/snapshot-utils.js';

describe('snapshot-utils', () => {
  describe('stableStringify', () => {
    it('sorts object keys', () => {
      expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    });

    it('handles nested objects', () => {
      expect(stableStringify({ z: { b: 1, a: 2 }, a: 0 }))
        .toBe('{"a":0,"z":{"a":2,"b":1}}');
    });

    it('handles arrays', () => {
      expect(stableStringify([3, 1, 2])).toBe('[3,1,2]');
    });

    it('filters undefined values', () => {
      expect(stableStringify({ a: 1, b: undefined })).toBe('{"a":1}');
    });

    it('handles null', () => {
      expect(stableStringify(null)).toBe('null');
    });

    it('handles primitives', () => {
      expect(stableStringify(42)).toBe('42');
      expect(stableStringify('hello')).toBe('"hello"');
      expect(stableStringify(true)).toBe('true');
    });

    it('is deterministic for same data', () => {
      const obj = { c: 3, a: 1, b: { z: 0, y: [1, 2] } };
      expect(stableStringify(obj)).toBe(stableStringify(obj));
    });
  });

  describe('computeSnapshotChecksum', () => {
    it('returns consistent sha256 hex for same input', () => {
      const snap = {
        schema: 'kb.registry/2' as const,
        rev: 1,
        version: '1',
        generatedAt: '2026-01-01T00:00:00Z',
        ttlMs: 60000,
        partial: false,
        stale: false,
        source: { cwd: '/tmp', platformVersion: '1.0.0' },
        plugins: [],
        manifests: [],
        observations: [],
        inputFingerprint: '',
        requestIdentity: 'test-request',
        ts: 1000,
      };

      const hash1 = computeSnapshotChecksum(snap);
      const hash2 = computeSnapshotChecksum(snap);
      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[a-f0-9]{64}$/);
    });

    it('changes when data changes', () => {
      const base = {
        schema: 'kb.registry/2' as const,
        rev: 1, version: '1', generatedAt: '2026-01-01T00:00:00Z',
        ttlMs: 60000, partial: false, stale: false,
        source: { cwd: '/tmp', platformVersion: '1.0.0' },
        plugins: [], manifests: [], observations: [], inputFingerprint: '', requestIdentity: 'test-request', ts: 1000,
      };

      const modified = { ...base, rev: 2 };
      expect(computeSnapshotChecksum(base)).not.toBe(computeSnapshotChecksum(modified));
    });
  });

  describe('cloneValue', () => {
    it('deep clones objects', () => {
      const original = { a: { b: [1, 2, 3] } };
      const cloned = cloneValue(original);
      expect(cloned).toEqual(original);
      expect(cloned).not.toBe(original);
      expect(cloned.a).not.toBe(original.a);
      expect(cloned.a.b).not.toBe(original.a.b);
    });
  });

  describe('safeParseInt', () => {
    it('returns number as floor', () => {
      expect(safeParseInt(3.7)).toBe(3);
    });

    it('parses string numbers', () => {
      expect(safeParseInt('42')).toBe(42);
    });

    it('returns 0 for invalid input', () => {
      expect(safeParseInt(null)).toBe(0);
      expect(safeParseInt(undefined)).toBe(0);
      expect(safeParseInt('abc')).toBe(0);
      expect(safeParseInt(NaN)).toBe(0);
      expect(safeParseInt(Infinity)).toBe(0);
    });
  });
});
