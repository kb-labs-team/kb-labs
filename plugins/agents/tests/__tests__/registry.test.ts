import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../src/tools/registry.js';
import type { Tool, ToolContext } from '../../src/tools/types.js';

function createMockContext(): ToolContext {
  return { workingDir: '/test/project' };
}

function createMockTool(name: string, executor?: Tool['executor']): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name,
        description: `Mock tool: ${name}`,
        parameters: { type: 'object', properties: {} },
      },
    },
    executor: executor ?? (async () => ({ success: true, output: 'ok' })),
  };
}

describe('ToolRegistry', () => {
  it('should register and retrieve a tool', () => {
    const registry = new ToolRegistry(createMockContext());
    const tool = createMockTool('test_tool');

    registry.register(tool);

    expect(registry.get('test_tool')).toBe(tool);
  });

  it('should return undefined for unknown tool', () => {
    const registry = new ToolRegistry(createMockContext());

    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('should return definitions of all registered tools', () => {
    const registry = new ToolRegistry(createMockContext());
    registry.register(createMockTool('alpha'));
    registry.register(createMockTool('beta'));

    const defs = registry.getDefinitions();

    expect(defs).toHaveLength(2);
    expect(defs.map((def) => def.function.name)).toEqual(['alpha', 'beta']);
  });

  it('should return sorted tool names', () => {
    const registry = new ToolRegistry(createMockContext());
    registry.register(createMockTool('zebra'));
    registry.register(createMockTool('alpha'));
    registry.register(createMockTool('middle'));

    expect(registry.getToolNames()).toEqual(['alpha', 'middle', 'zebra']);
  });

  it('should execute a registered tool', async () => {
    const registry = new ToolRegistry(createMockContext());
    const executor = async (input: Record<string, unknown>) => ({
      success: true,
      output: `received: ${input.key}`,
    });
    registry.register(createMockTool('my_tool', executor));

    const result = await registry.execute('my_tool', { key: 'value' });

    expect(result).toEqual({ success: true, output: 'received: value' });
  });

  it('should return error result when executing unknown tool', async () => {
    const registry = new ToolRegistry(createMockContext());

    const result = await registry.execute('missing', {});
    expect(result.success).toBe(false);
    expect(result.output).toContain('missing');
  });

  it('should return context from constructor', () => {
    const ctx = createMockContext();
    const registry = new ToolRegistry(ctx);

    expect(registry.getContext()).toBe(ctx);
  });

  it('should overwrite tool when registering with same name', () => {
    const registry = new ToolRegistry(createMockContext());
    const tool1 = createMockTool('dup');
    const tool2 = createMockTool('dup');

    registry.register(tool1);
    registry.register(tool2);

    expect(registry.get('dup')).toBe(tool2);
    expect(registry.getToolNames()).toEqual(['dup']);
  });
});
