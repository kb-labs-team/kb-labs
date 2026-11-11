import { describe, it, expect, vi } from 'vitest';
import { ModeRegistry, modeRegistry, getModeHandlerFromRegistry } from '../../src/core/modes/mode-registry.js';
import type { ModeHandler } from '../../src/core/modes/mode-handler.js';

// ── Stub ModeHandlers ─────────────────────────────────────────────────

function makeModeHandler(name: string): ModeHandler {
  return {
    execute: vi.fn().mockResolvedValue({ success: true, output: name }),
  } as unknown as ModeHandler;
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('ModeRegistry', () => {
  describe('register()', () => {
    it('registers a custom mode', async () => {
      const reg = new ModeRegistry();
      const handler = makeModeHandler('review');

      reg.register('review', () => handler);

      expect(reg.has('review')).toBe(true);
      expect(await reg.get('review')).toBe(handler);
    });

    it('throws on duplicate registration without override', () => {
      const reg = new ModeRegistry();
      reg.register('custom', () => makeModeHandler('a'));

      expect(() => reg.register('custom', () => makeModeHandler('b'))).toThrow(
        'already registered',
      );
    });

    it('allows override with { override: true }', async () => {
      const reg = new ModeRegistry();
      const handlerA = makeModeHandler('a');
      const handlerB = makeModeHandler('b');

      reg.register('custom', () => handlerA);
      reg.register('custom', () => handlerB, { override: true });

      expect(await reg.get('custom')).toBe(handlerB);
    });

    it('throws for empty mode name', () => {
      const reg = new ModeRegistry();
      expect(() => reg.register('', () => makeModeHandler('x'))).toThrow(
        'non-empty string',
      );
    });

    it('throws for whitespace-only mode name', () => {
      const reg = new ModeRegistry();
      expect(() => reg.register('   ', () => makeModeHandler('x'))).toThrow(
        'non-empty string',
      );
    });

    it('supports async factory', async () => {
      const reg = new ModeRegistry();
      const handler = makeModeHandler('async');

      reg.register('async-mode', async () => {
        await new Promise((r) => {
          setTimeout(r, 1);
        });
        return handler;
      });

      expect(await reg.get('async-mode')).toBe(handler);
    });
  });

  describe('built-in modes', () => {
    it('has execute registered by default', () => {
      const reg = new ModeRegistry();
      expect(reg.has('execute')).toBe(true);
    });

    it('has plan registered by default', () => {
      const reg = new ModeRegistry();
      expect(reg.has('plan')).toBe(true);
    });

    it('has edit registered by default', () => {
      const reg = new ModeRegistry();
      expect(reg.has('edit')).toBe(true);
    });

    it('has debug registered by default', () => {
      const reg = new ModeRegistry();
      expect(reg.has('debug')).toBe(true);
    });

    it('has spec registered by default', () => {
      const reg = new ModeRegistry();
      expect(reg.has('spec')).toBe(true);
    });

    it('lists all 5 built-in modes', () => {
      const reg = new ModeRegistry();
      const modes = reg.list();
      expect(modes).toContain('execute');
      expect(modes).toContain('plan');
      expect(modes).toContain('edit');
      expect(modes).toContain('debug');
      expect(modes).toContain('spec');
    });

    it('can override a built-in mode', async () => {
      const reg = new ModeRegistry();
      const custom = makeModeHandler('custom-execute');

      reg.register('execute', () => custom, { override: true });

      expect(await reg.get('execute')).toBe(custom);
    });
  });

  describe('get()', () => {
    it('falls back to execute when mode is not found', async () => {
      const reg = new ModeRegistry();
      const customExecute = makeModeHandler('execute');

      reg.register('execute', () => customExecute, { override: true });
      const handler = await reg.get('nonexistent-mode');

      expect(handler).toBe(customExecute);
    });

    it('throws when mode and execute fallback both missing', async () => {
      // Create a registry with no built-ins by clearing internals
      const reg = new ModeRegistry();
      // Clear all registrations (access internal map via type assertion)
      (reg as unknown as { registrations: Map<string, unknown> }).registrations.clear();

      await expect(reg.get('custom')).rejects.toThrow('not registered');
    });
  });

  describe('list()', () => {
    it('returns all registered mode names', () => {
      const reg = new ModeRegistry();
      reg.register('review', () => makeModeHandler('review'));
      reg.register('audit', () => makeModeHandler('audit'));

      const modes = reg.list();
      expect(modes).toContain('review');
      expect(modes).toContain('audit');
    });
  });

  describe('global singleton', () => {
    it('modeRegistry is a ModeRegistry instance', () => {
      expect(modeRegistry).toBeInstanceOf(ModeRegistry);
    });

    it('getModeHandlerFromRegistry falls back to execute for unknown mode', async () => {
      // We can verify by checking it returns without throwing
      // (uses the global singleton which has execute registered)
      const handler = await getModeHandlerFromRegistry('definitely-not-a-mode-xyzzy');
      expect(handler).toBeDefined();
      // Should be an ExecuteModeHandler (has execute method)
      expect(typeof handler.execute).toBe('function');
    });
  });
});
