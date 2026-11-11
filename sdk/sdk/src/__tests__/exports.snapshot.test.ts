/**
 * @module @kb-labs/sdk/__tests__/exports-snapshot
 *
 * Snapshot tests for SDK exports.
 * Ensures that exported APIs don't change accidentally.
 */

import { describe, it, expect } from 'vitest';
import { PluginError as ContractPluginError } from '@kb-labs/plugin-contracts';
import * as SDK from '../index.js';

describe('SDK Exports Snapshot', () => {
  it('should match snapshot of all exported names', () => {
    const exports = Object.keys(SDK).sort();
    expect(exports).toMatchSnapshot();
  });

  it('should match snapshot of exported functions', () => {
    const functions = Object.entries(SDK)
      .filter(([_key, value]) => typeof value === 'function')
      .map(([key]) => key)
      .sort();

    expect(functions).toMatchSnapshot();
  });

  it('should have createTestContext function', () => {
    expect(typeof SDK.createTestContext).toBe('function');
  });

  it('should have command definition helpers', () => {
    expect(typeof SDK.defineCommand).toBe('function');
    expect(typeof SDK.defineRoute).toBe('function');
    expect(typeof SDK.defineAction).toBe('function');
    expect(typeof SDK.defineWebhook).toBe('function');
  });

  it('uses the plugin-contracts PluginError class for SDK and defined product errors', () => {
    expect(SDK.PluginError).toBe(ContractPluginError);
    const Defined = SDK.defineError('IDENTITY', {
      Invalid: { code: 400, message: 'Invalid input', hint: 'Correct the input and retry.' },
    });
    const error = new Defined.Invalid();
    expect(error).toBeInstanceOf(SDK.PluginError);
    expect(error).toBeInstanceOf(ContractPluginError);
  });

  describe('Test Context Structure', () => {
    it('should create context with all required properties', () => {
      const ctx = SDK.createTestContext({
        pluginId: '@kb-labs/test',
        host: 'cli',
      });

      const contextKeys = Object.keys(ctx).sort();
      expect(contextKeys).toMatchSnapshot();
    });

    it('should provide ui.colors API', () => {
      const ctx = SDK.createTestContext();

      expect(ctx.ui.colors).toBeDefined();
      expect(typeof ctx.ui.colors.success).toBe('function');
      expect(typeof ctx.ui.colors.error).toBe('function');
      expect(typeof ctx.ui.colors.primary).toBe('function');
      expect(typeof ctx.ui.colors.bold).toBe('function');
    });

    it('should provide ui.write method', () => {
      const ctx = SDK.createTestContext();
      expect(typeof ctx.ui.write).toBe('function');
    });

    it('should match UI methods snapshot', () => {
      const ctx = SDK.createTestContext();
      const uiMethods = Object.keys(ctx.ui).sort();
      expect(uiMethods).toMatchSnapshot();
    });

    it('should match platform services snapshot', () => {
      const ctx = SDK.createTestContext();
      const platformServices = Object.keys(ctx.platform).sort();
      expect(platformServices).toMatchSnapshot();
    });

    it('should match colors API snapshot', () => {
      const ctx = SDK.createTestContext();
      const colorKeys = Object.keys(ctx.ui.colors).sort();
      expect(colorKeys).toMatchSnapshot();
    });
  });

  describe('Type Exports', () => {
    it('should export core contract types', () => {
      // These should be available as TypeScript types (checked at compile time)
      // We just verify the module structure here
      const typeChecks = {
        hasPluginContextV3: 'PluginContextV3' in SDK,
        hasUIFacade: 'UIFacade' in SDK,
        hasColors: 'Colors' in SDK,
        hasColorFunction: 'ColorFunction' in SDK,
        hasPlatformServices: 'PlatformServices' in SDK,
        hasRuntimeAPI: 'RuntimeAPI' in SDK,
        hasPluginAPI: 'PluginAPI' in SDK,
      };

      expect(typeChecks).toMatchSnapshot();
    });
  });
});
