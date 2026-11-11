import { describe, it, expect, vi } from 'vitest';
import { ToolManager } from '../../src/core/tools/tool-manager.js';
import type { ToolPack, PackedTool } from '@kb-labs/agents/contracts';

function makeTool(name: string, opts: { readOnly?: boolean; capability?: string } = {}): PackedTool {
  return {
    definition: {
      type: 'function',
      function: {
        name,
        description: `Tool ${name}`,
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    readOnly: opts.readOnly ?? false,
    capability: opts.capability,
    execute: async (input) => ({ success: true, output: `${name}:${JSON.stringify(input)}` }),
  };
}

function makePack(overrides: Partial<ToolPack> & { id: string; namespace: string }): ToolPack {
  return {
    version: '1.0.0',
    priority: 100,
    conflictPolicy: 'error',
    tools: [],
    ...overrides,
  };
}

describe('ToolManager', () => {
  describe('registration', () => {
    it('registers a pack and its tools', () => {
      const mgr = new ToolManager();
      mgr.register(makePack({
        id: 'core',
        namespace: 'core',
        tools: [makeTool('fs_read'), makeTool('fs_write')],
      }));

      expect(mgr.hasTool('fs_read')).toBe(true);
      expect(mgr.hasTool('fs_write')).toBe(true);
      expect(mgr.getPackIds()).toEqual(['core']);
    });

    it('skips disabled packs', () => {
      const mgr = new ToolManager();
      mgr.register(makePack({
        id: 'disabled',
        namespace: 'disabled',
        tools: [makeTool('foo')],
        enabled: () => false,
      }));

      expect(mgr.hasTool('foo')).toBe(false);
      expect(mgr.getPackIds()).toEqual([]);
    });

    it('throws on duplicate pack id', () => {
      const mgr = new ToolManager();
      mgr.register(makePack({ id: 'core', namespace: 'core', tools: [] }));
      expect(() =>
        mgr.register(makePack({ id: 'core', namespace: 'core2', tools: [] })),
      ).toThrow('already registered');
    });
  });

  describe('conflict resolution', () => {
    it('throws on name conflict with conflictPolicy "error"', () => {
      const mgr = new ToolManager();
      mgr.register(makePack({
        id: 'pack-a',
        namespace: 'a',
        conflictPolicy: 'error',
        tools: [makeTool('shared_tool')],
      }));

      expect(() =>
        mgr.register(makePack({
          id: 'pack-b',
          namespace: 'b',
          conflictPolicy: 'error',
          tools: [makeTool('shared_tool')],
        })),
      ).toThrow('Tool name conflict');
    });

    it('namespace-prefix: both tools available as qualified names', () => {
      const mgr = new ToolManager();
      mgr.register(makePack({
        id: 'pack-a',
        namespace: 'a',
        conflictPolicy: 'namespace-prefix',
        tools: [makeTool('read_file')],
      }));
      mgr.register(makePack({
        id: 'pack-b',
        namespace: 'b',
        conflictPolicy: 'namespace-prefix',
        tools: [makeTool('read_file')],
      }));

      expect(mgr.hasTool('a.read_file')).toBe(true);
      expect(mgr.hasTool('b.read_file')).toBe(true);
      // Short name should no longer be available (ambiguous)
      expect(mgr.hasTool('read_file')).toBe(false);
    });

    it('override: higher priority wins', () => {
      const mgr = new ToolManager();
      mgr.register(makePack({
        id: 'low',
        namespace: 'low',
        priority: 10,
        conflictPolicy: 'override',
        tools: [makeTool('shared')],
      }));
      mgr.register(makePack({
        id: 'high',
        namespace: 'high',
        priority: 100,
        conflictPolicy: 'override',
        tools: [makeTool('shared')],
      }));

      const tool = mgr.getTool('shared');
      expect(tool).toBeDefined();
      expect(tool!.packId).toBe('high');
    });

    it('no conflict when tools have different names', () => {
      const mgr = new ToolManager();
      mgr.register(makePack({
        id: 'a',
        namespace: 'a',
        tools: [makeTool('tool_a')],
      }));
      mgr.register(makePack({
        id: 'b',
        namespace: 'b',
        tools: [makeTool('tool_b')],
      }));

      expect(mgr.hasTool('tool_a')).toBe(true);
      expect(mgr.hasTool('tool_b')).toBe(true);
    });
  });

  describe('getTools / getDefinitions', () => {
    it('filters by readOnly', () => {
      const mgr = new ToolManager();
      mgr.register(makePack({
        id: 'core',
        namespace: 'core',
        tools: [
          makeTool('fs_read', { readOnly: true }),
          makeTool('fs_write', { readOnly: false }),
          makeTool('grep', { readOnly: true }),
        ],
      }));

      const readOnly = mgr.getTools({ readOnly: true });
      expect(readOnly).toHaveLength(2);
      expect(readOnly.map((t) => t.shortName).sort()).toEqual(['fs_read', 'grep']);
    });

    it('filters by capability', () => {
      const mgr = new ToolManager();
      mgr.register(makePack({
        id: 'core',
        namespace: 'core',
        tools: [
          makeTool('fs_read', { capability: 'filesystem' }),
          makeTool('grep', { capability: 'search' }),
          makeTool('fs_write', { capability: 'filesystem' }),
        ],
      }));

      const fs = mgr.getTools({ capability: 'filesystem' });
      expect(fs).toHaveLength(2);
    });

    it('filters by namespace', () => {
      const mgr = new ToolManager();
      mgr.register(makePack({
        id: 'core',
        namespace: 'core',
        tools: [makeTool('read')],
      }));
      mgr.register(makePack({
        id: 'kb',
        namespace: 'kb',
        tools: [makeTool('search')],
      }));

      const kbTools = mgr.getTools({ namespace: 'kb' });
      expect(kbTools).toHaveLength(1);
      expect(kbTools[0]!.shortName).toBe('search');
    });

    it('getDefinitions returns tool definitions', () => {
      const mgr = new ToolManager();
      mgr.register(makePack({
        id: 'core',
        namespace: 'core',
        tools: [makeTool('a'), makeTool('b')],
      }));

      const defs = mgr.getDefinitions();
      expect(defs).toHaveLength(2);
      expect(defs[0]!.function.name).toBeDefined();
    });

    it('getToolNames returns sorted names', () => {
      const mgr = new ToolManager();
      mgr.register(makePack({
        id: 'core',
        namespace: 'core',
        tools: [makeTool('z_tool'), makeTool('a_tool'), makeTool('m_tool')],
      }));

      expect(mgr.getToolNames()).toEqual(['a_tool', 'm_tool', 'z_tool']);
    });
  });

  describe('execute', () => {
    it('executes a registered tool', async () => {
      const mgr = new ToolManager();
      mgr.register(makePack({
        id: 'core',
        namespace: 'core',
        tools: [makeTool('echo')],
      }));

      const result = await mgr.execute('echo', { msg: 'hello' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('echo');
    });

    it('returns error for unknown tool', async () => {
      const mgr = new ToolManager();
      const result = await mgr.execute('nonexistent', {});
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('permissions', () => {
    it('blocks denied commands', async () => {
      const mgr = new ToolManager();
      mgr.register(makePack({
        id: 'restricted',
        namespace: 'restricted',
        permissions: {
          deniedCommands: ['rm -rf', 'sudo'],
        },
        tools: [makeTool('shell_exec')],
      }));

      const result = await mgr.execute('shell_exec', { command: 'rm -rf /' });
      expect(result.success).toBe(false);
      expect(result.errorDetails?.code).toBe('PERMISSION_DENIED');
    });

    it('allows non-denied commands', async () => {
      const mgr = new ToolManager();
      mgr.register(makePack({
        id: 'restricted',
        namespace: 'restricted',
        permissions: {
          deniedCommands: ['rm -rf'],
        },
        tools: [makeTool('shell_exec')],
      }));

      const result = await mgr.execute('shell_exec', { command: 'ls -la' });
      expect(result.success).toBe(true);
    });

    it('blocks paths outside allowedPaths', async () => {
      const mgr = new ToolManager();
      mgr.register(makePack({
        id: 'sandboxed',
        namespace: 'sandboxed',
        permissions: {
          allowedPaths: ['/home/user/project'],
        },
        tools: [makeTool('fs_read')],
      }));

      const result = await mgr.execute('fs_read', { path: '/etc/passwd' });
      expect(result.success).toBe(false);
      expect(result.errorDetails?.code).toBe('PATH_DENIED');
    });

    it('allows paths within allowedPaths', async () => {
      const mgr = new ToolManager();
      mgr.register(makePack({
        id: 'sandboxed',
        namespace: 'sandboxed',
        permissions: {
          allowedPaths: ['/home/user/project'],
        },
        tools: [makeTool('fs_read')],
      }));

      const result = await mgr.execute('fs_read', { path: '/home/user/project/src/index.ts' });
      expect(result.success).toBe(true);
    });
  });

  describe('audit trail', () => {
    it('calls onAudit when pack has auditTrail enabled', async () => {
      const onAudit = vi.fn();
      const mgr = new ToolManager({ onAudit });
      mgr.register(makePack({
        id: 'audited',
        namespace: 'audited',
        permissions: { auditTrail: true },
        tools: [makeTool('action')],
      }));

      await mgr.execute('action', { foo: 'bar' });
      expect(onAudit).toHaveBeenCalledWith('action', 'audited', { foo: 'bar' });
    });

    it('does not call onAudit when auditTrail is false', async () => {
      const onAudit = vi.fn();
      const mgr = new ToolManager({ onAudit });
      mgr.register(makePack({
        id: 'core',
        namespace: 'core',
        permissions: { auditTrail: false },
        tools: [makeTool('action')],
      }));

      await mgr.execute('action', {});
      expect(onAudit).not.toHaveBeenCalled();
    });
  });

  describe('lifecycle', () => {
    it('calls initialize on all packs', async () => {
      const init = vi.fn();
      const mgr = new ToolManager();
      mgr.register(makePack({
        id: 'core',
        namespace: 'core',
        tools: [],
        initialize: init,
      }));

      await mgr.initializeAll();
      expect(init).toHaveBeenCalledOnce();
    });

    it('calls dispose on all packs', async () => {
      const dispose = vi.fn();
      const mgr = new ToolManager();
      mgr.register(makePack({
        id: 'core',
        namespace: 'core',
        tools: [],
        dispose,
      }));

      await mgr.disposeAll();
      expect(dispose).toHaveBeenCalledOnce();
    });
  });
});
