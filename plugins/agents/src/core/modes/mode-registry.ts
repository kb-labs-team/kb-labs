/**
 * ModeRegistry — dynamic mode registration without modifying core.
 *
 * Replaces the switch/case in getModeHandler() with a registry that can
 * be extended with custom modes at runtime.
 *
 * Built-in modes are registered lazily (dynamic import) to preserve
 * tree-shaking and the existing performance characteristics.
 *
 * Usage (custom mode):
 *   modeRegistry.register('review', () => new ReviewModeHandler());
 *   // Now agent config { mode: 'review' } uses ReviewModeHandler
 *
 * Usage (override built-in):
 *   modeRegistry.register('plan', () => new CustomPlanHandler(), { override: true });
 */

import type { ModeHandler } from './mode-handler.js';

// ═══════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════

/** Factory function that creates a ModeHandler instance */
export type ModeHandlerFactory = () => ModeHandler | Promise<ModeHandler>;

export interface ModeRegistration {
  readonly mode: string;
  readonly factory: ModeHandlerFactory;
  readonly builtIn: boolean;
}

export interface RegisterOptions {
  /** Allow overriding an already-registered mode (including built-ins) */
  override?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════
// ModeRegistry
// ═══════════════════════════════════════════════════════════════════════

export class ModeRegistry {
  private readonly registrations = new Map<string, ModeRegistration>();

  constructor() {
    this.registerBuiltIns();
  }

  // ── Registration ────────────────────────────────────────────────────

  /**
   * Register a mode handler factory.
   *
   * @throws If mode is already registered and override is not set.
   */
  register(mode: string, factory: ModeHandlerFactory, options: RegisterOptions = {}): void {
    if (!mode || mode.trim() === '') {
      throw new Error('ModeRegistry: mode name must be a non-empty string');
    }

    if (this.registrations.has(mode) && !options.override) {
      throw new Error(
        `ModeRegistry: mode "${mode}" is already registered. ` +
        `Use { override: true } to replace it.`,
      );
    }

    this.registrations.set(mode, {
      mode,
      factory,
      builtIn: false,
    });
  }

  /**
   * Check whether a mode is registered.
   */
  has(mode: string): boolean {
    return this.registrations.has(mode);
  }

  /**
   * List all registered mode names.
   */
  list(): string[] {
    return Array.from(this.registrations.keys());
  }

  /**
   * Get a ModeHandler for the given mode.
   * Falls back to 'execute' if mode is not found.
   *
   * @throws If neither the requested mode nor 'execute' fallback is registered.
   */
  async get(mode: string): Promise<ModeHandler> {
    const registration = this.registrations.get(mode);

    if (registration) {
      return registration.factory();
    }

    // Fallback to execute
    const fallback = this.registrations.get('execute');
    if (fallback) {
      return fallback.factory();
    }

    throw new Error(`ModeRegistry: mode "${mode}" is not registered and no 'execute' fallback exists`);
  }

  // ── Built-in Modes ──────────────────────────────────────────────────

  private registerBuiltIns(): void {
    const builtIns: Array<[string, ModeHandlerFactory]> = [
      ['execute', async () => {
        const { ExecuteModeHandler } = await import('./execute-mode-handler.js');
        return new ExecuteModeHandler();
      }],
      ['plan', async () => {
        const { PlanModeHandler } = await import('./plan-mode-handler.js');
        return new PlanModeHandler();
      }],
      ['edit', async () => {
        const { EditModeHandler } = await import('./edit-mode-handler.js');
        return new EditModeHandler();
      }],
      ['debug', async () => {
        const { DebugModeHandler } = await import('./debug-mode-handler.js');
        return new DebugModeHandler();
      }],
    ];

    // Spec mode is optional — only register if present
    builtIns.push(['spec', async () => {
      const { SpecModeHandler } = await import('./spec-mode-handler.js');
      return new SpecModeHandler() as unknown as ModeHandler;
    }]);

    for (const [mode, factory] of builtIns) {
      this.registrations.set(mode, { mode, factory, builtIn: true });
    }
  }
}

// ── Global registry singleton ────────────────────────────────────────

/**
 * Global ModeRegistry instance.
 *
 * Use this to register custom modes application-wide:
 *   import { modeRegistry } from '@kb-labs/agents/core';
 *   modeRegistry.register('my-mode', () => new MyModeHandler());
 */
export const modeRegistry = new ModeRegistry();

/**
 * Convenience function that replaces the old getModeHandler() switch/case.
 * Delegates to the global modeRegistry.
 */
export async function getModeHandlerFromRegistry(mode: string): Promise<ModeHandler> {
  return modeRegistry.get(mode);
}
