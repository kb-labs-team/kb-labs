/**
 * Unit tests for ExecutionRegistry (CC2 — Cancellation).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ExecutionRegistry } from '../execute/execution-registry.js';

function makeEntry(overrides: Partial<{
  executionId: string;
  requestId: string;
  namespaceId: string;
  hostId: string;
  pluginId: string;
  commandPath: string;
}> = {}) {
  return {
    executionId: 'exec-1',
    requestId: 'req-1',
    namespaceId: 'ns-1',
    hostId: 'host-1',
    pluginId: 'plugin-a',
    commandPath: 'handlers/run.ts',
    ...overrides,
  };
}

describe('ExecutionRegistry', () => {
  let registry: ExecutionRegistry;

  beforeEach(() => {
    registry = new ExecutionRegistry();
  });

  // ── register ──────────────────────────────────────────────────────────────

  describe('register()', () => {
    it('returns an AbortSignal', () => {
      const signal = registry.register(makeEntry());
      expect(signal).toBeInstanceOf(AbortSignal);
    });

    it('signal is not aborted initially', () => {
      const signal = registry.register(makeEntry());
      expect(signal.aborted).toBe(false);
    });

    it('stores execution metadata', () => {
      registry.register(makeEntry({ executionId: 'exec-x' }));
      const entry = registry.get('exec-x');
      expect(entry?.namespaceId).toBe('ns-1');
      expect(entry?.hostId).toBe('host-1');
      expect(entry?.pluginId).toBe('plugin-a');
      expect(entry?.startedAt).toBeTypeOf('number');
    });

    it('increments size', () => {
      registry.register(makeEntry({ executionId: 'a' }));
      registry.register(makeEntry({ executionId: 'b' }));
      expect(registry.size).toBe(2);
    });
  });

  // ── cancel ────────────────────────────────────────────────────────────────

  describe('cancel()', () => {
    it('returns true and aborts signal', () => {
      const signal = registry.register(makeEntry());
      const result = registry.cancel('exec-1', 'user');
      expect(result).toBe(true);
      expect(signal.aborted).toBe(true);
    });

    it('stores cancellation reason on the entry', () => {
      registry.register(makeEntry());
      registry.cancel('exec-1', 'timeout');
      expect(registry.get('exec-1')?.cancelledReason).toBe('timeout');
    });

    it('returns false for non-existent executionId', () => {
      expect(registry.cancel('does-not-exist', 'user')).toBe(false);
    });

    it('returns false when already cancelled (idempotent)', () => {
      registry.register(makeEntry());
      expect(registry.cancel('exec-1', 'user')).toBe(true);
      expect(registry.cancel('exec-1', 'timeout')).toBe(false);
    });

    it('abort signal reason matches provided reason', () => {
      const signal = registry.register(makeEntry());
      registry.cancel('exec-1', 'disconnect');
      expect(signal.reason).toBe('disconnect');
    });
  });

  // ── remove ────────────────────────────────────────────────────────────────

  describe('remove()', () => {
    it('removes execution from registry', () => {
      registry.register(makeEntry());
      registry.remove('exec-1');
      expect(registry.get('exec-1')).toBeUndefined();
    });

    it('decrements size', () => {
      registry.register(makeEntry({ executionId: 'a' }));
      registry.register(makeEntry({ executionId: 'b' }));
      registry.remove('a');
      expect(registry.size).toBe(1);
    });

    it('is no-op for non-existent id', () => {
      expect(() => registry.remove('ghost')).not.toThrow();
    });
  });

  // ── get ───────────────────────────────────────────────────────────────────

  describe('get()', () => {
    it('returns undefined for unknown id', () => {
      expect(registry.get('unknown')).toBeUndefined();
    });

    it('returns the active execution', () => {
      registry.register(makeEntry({ executionId: 'exec-abc' }));
      const entry = registry.get('exec-abc');
      expect(entry?.executionId).toBe('exec-abc');
    });
  });

  // ── cancelByHost ──────────────────────────────────────────────────────────

  describe('cancelByHost()', () => {
    it('cancels all executions for given hostId', () => {
      const sig1 = registry.register(makeEntry({ executionId: 'e1', hostId: 'host-A' }));
      const sig2 = registry.register(makeEntry({ executionId: 'e2', hostId: 'host-A' }));
      const sig3 = registry.register(makeEntry({ executionId: 'e3', hostId: 'host-B' }));

      const cancelled = registry.cancelByHost('host-A', 'disconnect');

      expect(cancelled).toContain('e1');
      expect(cancelled).toContain('e2');
      expect(cancelled).not.toContain('e3');
      expect(sig1.aborted).toBe(true);
      expect(sig2.aborted).toBe(true);
      expect(sig3.aborted).toBe(false);
    });

    it('returns empty array when no executions for host', () => {
      registry.register(makeEntry({ executionId: 'e1', hostId: 'host-X' }));
      const result = registry.cancelByHost('host-Z', 'disconnect');
      expect(result).toEqual([]);
    });

    it('skips already-aborted executions', () => {
      registry.register(makeEntry({ executionId: 'e1', hostId: 'host-A' }));
      registry.cancel('e1', 'user'); // pre-cancel
      const cancelled = registry.cancelByHost('host-A', 'disconnect');
      expect(cancelled).not.toContain('e1');
    });

    it('returns executionIds of cancelled executions', () => {
      registry.register(makeEntry({ executionId: 'alpha', hostId: 'host-1' }));
      const result = registry.cancelByHost('host-1', 'disconnect');
      expect(result).toEqual(['alpha']);
    });
  });

  // ── size ──────────────────────────────────────────────────────────────────

  describe('size', () => {
    it('starts at 0', () => {
      expect(registry.size).toBe(0);
    });

    it('tracks additions and removals correctly', () => {
      registry.register(makeEntry({ executionId: 'a' }));
      registry.register(makeEntry({ executionId: 'b' }));
      registry.register(makeEntry({ executionId: 'c' }));
      registry.remove('b');
      expect(registry.size).toBe(2);
    });
  });
});

// ── CancelledError ────────────────────────────────────────────────────────────

import { CancelledError } from '../execute/errors.js';

describe('CancelledError', () => {
  it('stores reason', () => {
    const err = new CancelledError('timeout');
    expect(err.reason).toBe('timeout');
  });

  it('has descriptive message', () => {
    const err = new CancelledError('user');
    expect(err.message).toContain('Execution cancelled');
    expect(err.message).toContain('user');
  });

  it('has correct name', () => {
    expect(new CancelledError('disconnect').name).toBe('CancelledError');
  });

  it('is instanceof Error', () => {
    expect(new CancelledError('user')).toBeInstanceOf(Error);
  });

  it('is instanceof CancelledError', () => {
    expect(new CancelledError('user')).toBeInstanceOf(CancelledError);
  });

  it('supports all cancellation reasons', () => {
    for (const reason of ['user', 'timeout', 'disconnect'] as const) {
      expect(() => new CancelledError(reason)).not.toThrow();
    }
  });
});
