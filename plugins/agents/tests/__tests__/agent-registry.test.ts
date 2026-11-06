import { describe, it, expect, beforeEach } from 'vitest';
import { AgentRegistry } from '../../src/core/agents/agent-registry.js';
import type { AgentTypeDefinition } from '../../src/core/agents/agent-registry.js';
import { DEFAULT_FEATURE_FLAGS } from '@kb-labs/agents/contracts';

describe('AgentRegistry', () => {
  let registry: AgentRegistry;

  beforeEach(() => {
    registry = new AgentRegistry();
  });

  describe('built-in presets', () => {
    it('has researcher preset', () => {
      const def = registry.get('researcher');
      expect(def).toBeDefined();
      expect(def?.readOnly).toBe(true);
      expect(def?.maxDepth).toBe(0);
      expect(def?.toolPacks).toContain('core');
    });

    it('has coder preset with write access', () => {
      const def = registry.get('coder');
      expect(def).toBeDefined();
      expect(def?.readOnly).toBe(false);
      expect(def?.toolPacks).toContain('coder');
    });

    it('has reviewer preset (read-only)', () => {
      const def = registry.get('reviewer');
      expect(def).toBeDefined();
      expect(def?.readOnly).toBe(true);
    });

    it('has orchestrator preset with maxDepth 3', () => {
      const def = registry.get('orchestrator');
      expect(def?.maxDepth).toBe(3);
    });

    it('lists 4 built-in presets', () => {
      expect(registry.listIds()).toHaveLength(4);
      expect(registry.listIds()).toContain('researcher');
      expect(registry.listIds()).toContain('coder');
      expect(registry.listIds()).toContain('reviewer');
      expect(registry.listIds()).toContain('orchestrator');
    });
  });

  describe('register()', () => {
    it('registers a custom definition', () => {
      const custom: AgentTypeDefinition = {
        id: 'tester',
        label: 'Tester',
        description: 'Runs tests',
        toolPacks: ['core', 'coder'],
        maxIterations: 8,
        readOnly: false,
        maxDepth: 0,
      };
      registry.register(custom);
      expect(registry.get('tester')).toEqual(custom);
    });

    it('overrides an existing preset', () => {
      const override: AgentTypeDefinition = {
        id: 'researcher',
        label: 'Researcher v2',
        description: 'Updated',
        toolPacks: ['core'],
        maxIterations: 25,
        readOnly: true,
        maxDepth: 1,
      };
      registry.register(override);
      expect(registry.get('researcher')?.maxIterations).toBe(25);
    });

    it('throws when id is empty', () => {
      expect(() =>
        registry.register({
          id: '',
          label: 'X',
          description: '',
          toolPacks: [],
          maxIterations: 5,
          readOnly: true,
          maxDepth: 0,
        }),
      ).toThrow('non-empty');
    });
  });

  describe('get() and getOrThrow()', () => {
    it('returns undefined for unknown id', () => {
      expect(registry.get('ghost')).toBeUndefined();
    });

    it('throws for unknown id on getOrThrow()', () => {
      expect(() => registry.getOrThrow('ghost')).toThrow("'ghost' not found");
    });

    it('lists available ids in error message', () => {
      try {
        registry.getOrThrow('ghost');
      } catch (e) {
        expect((e as Error).message).toContain('researcher');
      }
    });
  });

  describe('has()', () => {
    it('returns true for registered id', () => {
      expect(registry.has('coder')).toBe(true);
    });

    it('returns false for unknown id', () => {
      expect(registry.has('unknown')).toBe(false);
    });
  });

  describe('resolveFeatureFlags()', () => {
    it('merges DEFAULT_FEATURE_FLAGS with preset overrides', () => {
      const flags = registry.resolveFeatureFlags('researcher');
      // researcher has searchSignal: true, taskClassifier: true
      expect(flags.searchSignal).toBe(true);
      expect(flags.taskClassifier).toBe(true);
      // others stay at default (false)
      expect(flags.reflection).toBe(false);
      expect(flags.todoSync).toBe(false);
    });

    it('returns default flags for unknown id', () => {
      const flags = registry.resolveFeatureFlags('ghost');
      expect(flags).toEqual(DEFAULT_FEATURE_FLAGS);
    });

    it('coder has todoSync and reflection enabled', () => {
      const flags = registry.resolveFeatureFlags('coder');
      expect(flags.todoSync).toBe(true);
      expect(flags.reflection).toBe(true);
      expect(flags.searchSignal).toBe(false);
    });
  });

  describe('list()', () => {
    it('returns all definitions', () => {
      const all = registry.list();
      expect(all.length).toBe(4);
      expect(all.every((d) => typeof d.id === 'string')).toBe(true);
    });
  });
});
