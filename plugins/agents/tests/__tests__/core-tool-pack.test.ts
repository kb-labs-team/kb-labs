import { describe, it, expect, vi } from 'vitest';
import { createCoreToolPack, type LegacyToolRegistry } from '../../src/core/tools/core-tool-pack.js';
import { ToolManager } from '../../src/core/tools/tool-manager.js';

function makeLegacyRegistry(toolNames: string[]): LegacyToolRegistry {
  return {
    getDefinitions: () =>
      toolNames.map((name) => ({
        type: 'function' as const,
        function: {
          name,
          description: `Legacy tool ${name}`,
          parameters: { type: 'object', properties: {}, required: [] },
        },
      })),
    execute: vi.fn(async (name: string, input: Record<string, unknown>) => ({
      success: true,
      output: `executed:${name}`,
    })),
    getToolNames: () => toolNames.sort(),
  };
}

describe('CoreToolPack', () => {
  it('wraps all legacy tools', () => {
    const registry = makeLegacyRegistry(['fs_read', 'fs_write', 'shell_exec']);
    const pack = createCoreToolPack(registry);

    expect(pack.id).toBe('core');
    expect(pack.namespace).toBe('core');
    expect(pack.tools).toHaveLength(3);
  });

  it('marks read-only tools correctly', () => {
    const registry = makeLegacyRegistry(['fs_read', 'fs_write', 'grep_search']);
    const pack = createCoreToolPack(registry);

    const readOnly = pack.tools.filter((t) => t.readOnly);
    const readWrite = pack.tools.filter((t) => !t.readOnly);

    expect(readOnly.map((t) => t.definition.function.name).sort()).toEqual(['fs_read', 'grep_search']);
    expect(readWrite.map((t) => t.definition.function.name)).toEqual(['fs_write']);
  });

  it('assigns capability categories', () => {
    const registry = makeLegacyRegistry(['fs_read', 'shell_exec', 'report']);
    const pack = createCoreToolPack(registry);

    const capabilities = pack.tools.map((t) => ({
      name: t.definition.function.name,
      capability: t.capability,
    }));

    expect(capabilities).toEqual([
      { name: 'fs_read', capability: 'filesystem' },
      { name: 'shell_exec', capability: 'shell' },
      { name: 'report', capability: 'interaction' },
    ]);
  });

  it('delegates execution to legacy registry', async () => {
    const registry = makeLegacyRegistry(['fs_read']);
    const pack = createCoreToolPack(registry);

    const result = await pack.tools[0]!.execute({ path: '/tmp/test' });
    expect(result.success).toBe(true);
    expect(registry.execute).toHaveBeenCalledWith('fs_read', { path: '/tmp/test' });
  });

  it('integrates with ToolManager', () => {
    const registry = makeLegacyRegistry(['fs_read', 'fs_write', 'grep_search']);
    const pack = createCoreToolPack(registry);

    const mgr = new ToolManager();
    mgr.register(pack);

    expect(mgr.hasTool('fs_read')).toBe(true);
    expect(mgr.hasTool('fs_write')).toBe(true);
    expect(mgr.hasTool('grep_search')).toBe(true);

    // Read-only filter works
    const readOnly = mgr.getTools({ readOnly: true });
    expect(readOnly.every((t) => t.readOnly)).toBe(true);
  });
});
