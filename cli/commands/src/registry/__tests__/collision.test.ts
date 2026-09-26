/**
 * Collision Detection Tests
 *
 * Tests that system commands always win over plugin commands,
 * that malicious plugins cannot escape the sandbox,
 * and that namespace ownership (1 manifest = 1 namespace, ADR-0018) is enforced.
 */

import { describe, it, expect, vi } from 'vitest';
import { TrieBackedRegistry } from '../service';
import type { RegisteredCommand } from '../types';
import type { Command as SystemCommand, CommandGroup as SystemGroup } from '@kb-labs/shared-command-kit';

import type { ILogger } from '@kb-labs/core-platform';

// Helper to create a fresh registry per test
function makeRegistry() {
  return new TrieBackedRegistry();
}

/** Logger that captures warn calls for assertion. */
function makeCapturingLogger(): ILogger & { warns: string[] } {
  const warns: string[] = [];
  const logger = {
    warns,
    debug: () => {},
    info:  () => {},
    warn:  (msg: string) => { warns.push(msg); },
    error: () => {},
    child: () => logger,
  } as unknown as ILogger & { warns: string[] };
  return logger;
}

function makeSystemCmd(name: string, aliases: string[] = []): SystemCommand {
  return {
    name,
    describe: `System command: ${name}`,
    category: 'system',
    aliases,
    async run() { return 0; },
  };
}

function makePlugin(
  group: string,
  id: string,
  aliases?: string[],
): RegisteredCommand {
  const segments = group ? [group, id] : [id];
  return {
    manifest: {
      manifestVersion: '1.0',
      segments,
      id,
      group,
      describe: `Plugin: ${id}`,
      aliases,
      loader: async () => ({ run: async () => 1 }),
    },
    // First-party package so tier-F reserved names are allowed
    packageName: '@kb-labs/test-plugin',
    available: true,
    source: 'workspace',
    shadowed: false,
  };
}

/**
 * Helper for namespace ownership tests.
 * packageName maps to the npm package name (set by discovery).
 */
function makePluginCmd(
  group: string,
  id: string,
  packageName?: string,
  aliases?: string[],
): RegisteredCommand {
  return {
    manifest: {
      manifestVersion: '1.0',
      segments: [group, id],
      id,
      group,
      describe: `Plugin: ${group} ${id}`,
      aliases,
      loader: async () => ({ run: async () => 0 }),
    },
    packageName,
    available: true,
    source: 'workspace',
    shadowed: false,
  };
}

describe('Collision Detection', () => {
  it('should prevent plugin from overriding system command with same canonical ID', () => {
    const reg = makeRegistry();

    // Register system group 'sample' with command 'test-cmd' at path ['sample', 'test-cmd']
    const group: SystemGroup = { name: 'sample', describe: 'Sample', commands: [makeSystemCmd('test-cmd')] };
    reg.registerGroup(group);

    // Try to register plugin with same canonical path
    const pluginCmd = makePlugin('sample', 'test-cmd');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    reg.registerManifest(pluginCmd);
    warnSpy.mockRestore();

    // Plugin is marked as shadowed
    expect(pluginCmd.shadowed).toBe(true);

    // Routing returns system command
    const result = reg.resolve(['sample', 'test-cmd']);
    expect(result.type).toBe('system-cmd');
  });

  it('should NOT shadow plugin when only bare id matches system command', () => {
    const reg = makeRegistry();

    // System command "test-cmd" (bare, no group)
    const systemCmd = makeSystemCmd('test-cmd');
    reg.register(systemCmd);

    // Plugin canonical path is ['sample', 'test-cmd'] — different from ['test-cmd']
    const pluginCmd = makePlugin('sample', 'test-cmd');
    reg.registerManifest(pluginCmd);

    // Plugin should NOT be shadowed — different path
    expect(pluginCmd.shadowed).toBe(false);

    // System command still resolves
    const sysResult = reg.resolve(['test-cmd']);
    expect(sysResult.type).toBe('system-cmd');

    // Plugin also resolves
    const pluginResult = reg.resolve(['sample', 'test-cmd']);
    expect(pluginResult.type).toBe('command');
  });

  it('should prevent plugin alias from overriding system command', () => {
    const reg = makeRegistry();

    // 1. Register system command with alias 'sc'
    const systemCmd = makeSystemCmd('sys-cmd', ['sc']);
    reg.register(systemCmd);

    // 2. Try to register plugin with alias 'sc' — collision
    const pluginCmd: RegisteredCommand = {
      manifest: {
        manifestVersion: '1.0',
        segments: ['test', 'plugin-cmd'],
        id: 'plugin-cmd',
        group: 'test',
        describe: 'Plugin with colliding alias',
        aliases: ['sc'],
        loader: async () => ({ run: async () => 1 }),
      },
      available: true,
      source: 'workspace',
      shadowed: false,
    };

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    reg.registerManifest(pluginCmd);
    warnSpy.mockRestore();

    // 3. System command still resolves via alias
    const result = reg.resolve(['sc']);
    expect(result.type).toBe('system-cmd');
    if (result.type === 'system-cmd') {
      expect(result.cmd).toBe(systemCmd);
    }
  });

  it('should route system commands to in-process execution', () => {
    const reg = makeRegistry();

    // Register system group
    const group: SystemGroup = {
      name: 'info',
      describe: 'Info commands',
      commands: [
        makeSystemCmd('hello'),
      ],
    };
    reg.registerGroup(group);

    // Verify routing
    const result = reg.resolve(['info', 'hello']);
    expect(result.type).toBe('system-cmd');
    if (result.type === 'system-cmd') {
      expect(result.cmd).toHaveProperty('run');
    }
  });

  it('should route plugin commands to subprocess execution', () => {
    const reg = makeRegistry();

    const pluginCmd: RegisteredCommand = {
      manifest: {
        manifestVersion: '1.0',
        segments: ['custom', 'my-plugin'],
        id: 'my-plugin',
        group: 'custom',
        describe: 'Custom plugin',
        loader: async () => ({ run: async () => 0 }),
        manifestV2: {
          schema: 'kb.plugin/3' as const,
          id: '@kb-labs/my-plugin',
          version: '1.0.0',
          display: { name: 'My Plugin' },
          cli: {
            commands: [
              {
                path: 'custom my-plugin',
                describe: 'My plugin command',
                handler: './dist/handler.js',
              },
            ],
          },
        },
      },
      available: true,
      source: 'workspace',
      shadowed: false,
    };
    reg.registerManifest(pluginCmd);

    const result = reg.resolve(['custom', 'my-plugin']);
    expect(result.type).toBe('command');
  });

  it('should handle CommandGroup routing', () => {
    const reg = makeRegistry();

    const group: SystemGroup = {
      name: 'plugins',
      describe: 'Plugin management',
      commands: [makeSystemCmd('list')],
    };
    reg.registerGroup(group);

    // Verify group routing
    const result = reg.resolve(['plugins']);
    expect(result.type).toBe('system-group');
    if (result.type === 'system-group') {
      expect(result.group).toHaveProperty('commands');
    }
  });

  it('shadowed plugin is not routed to', () => {
    const reg = makeRegistry();

    // System group 'security' with command 'auth' at path ['security', 'auth']
    const group: SystemGroup = { name: 'security', describe: 'Security', commands: [makeSystemCmd('auth')] };
    reg.registerGroup(group);

    const pluginCmd = makePlugin('security', 'auth');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    reg.registerManifest(pluginCmd);
    warnSpy.mockRestore();

    // Plugin is marked as shadowed
    expect(pluginCmd.shadowed).toBe(true);

    // Routing goes to system command
    const result = reg.resolve(['security', 'auth']);
    expect(result.type).toBe('system-cmd');
  });
});

// ─── Plugin-vs-Plugin Namespace Ownership (ADR-0018) ─────────────────────────

describe('Plugin-vs-Plugin Namespace Ownership', () => {
  it('first plugin to register a group becomes the owner and is not shadowed', () => {
    const reg = makeRegistry();
    const logger = makeCapturingLogger();
    reg.setLogger(logger);

    const first = makePluginCmd('analytics', 'report', '@kb-labs/analytics');
    reg.registerManifest(first);

    expect(first.shadowed).toBe(false);
    expect(logger.warns).toHaveLength(0);
  });

  it('second plugin with different packageName is shadowed and a warning is emitted', () => {
    const reg = makeRegistry();
    const logger = makeCapturingLogger();
    reg.setLogger(logger);

    const first   = makePluginCmd('analytics', 'report',  '@kb-labs/analytics');
    const intruder = makePluginCmd('analytics', 'export', '@evil/analytics-hijack');
    reg.registerManifest(first);
    reg.registerManifest(intruder);

    expect(intruder.shadowed).toBe(true);
    expect(logger.warns.length).toBeGreaterThanOrEqual(1);
  });

  it('same packageName can co-fill the same namespace', () => {
    const reg = makeRegistry();
    const logger = makeCapturingLogger();
    reg.setLogger(logger);

    const cmd1 = makePluginCmd('analytics', 'report',  '@kb-labs/analytics');
    const cmd2 = makePluginCmd('analytics', 'export',  '@kb-labs/analytics');
    const cmd3 = makePluginCmd('analytics', 'settings','@kb-labs/analytics');
    reg.registerManifest(cmd1);
    reg.registerManifest(cmd2);
    reg.registerManifest(cmd3);

    expect(cmd1.shadowed).toBe(false);
    expect(cmd2.shadowed).toBe(false);
    expect(cmd3.shadowed).toBe(false);
    expect(logger.warns).toHaveLength(0);
  });

  it('shadowed intruder command is not routed — first owner wins', () => {
    const reg = makeRegistry();
    reg.setLogger(makeCapturingLogger());

    const first   = makePluginCmd('analytics', 'report', '@kb-labs/analytics');
    const intruder = makePluginCmd('analytics', 'report', '@evil/analytics-hijack');
    reg.registerManifest(first);
    reg.registerManifest(intruder);

    const result = reg.resolve(['analytics', 'report']);
    expect(result.type).toBe('command');
    if (result.type === 'command') {
      expect(result.command).toBe(first);
    }
  });

  it('alias pointing into an already-owned group is blocked', () => {
    const reg = makeRegistry();
    const logger = makeCapturingLogger();
    reg.setLogger(logger);

    // Establish ownership of 'analytics'
    const owner = makePluginCmd('analytics', 'report', '@kb-labs/analytics');
    reg.registerManifest(owner);

    // Intruder tries to slip in via alias
    const intruder = makePluginCmd('reporting', 'export', '@evil/pkg', ['analytics export']);
    reg.registerManifest(intruder);

    // Main registration is fine (different top-level group 'reporting')
    expect(intruder.shadowed).toBe(false);

    // But the alias 'analytics export' should have been skipped
    const aliasResult = reg.resolve(['analytics', 'export']);
    // Should not route to the intruder's command
    expect(aliasResult.type).not.toBe('command');
    expect(logger.warns.some(w => w.includes('analytics'))).toBe(true);
  });

  it('undefined packageName is treated as __unknown__ and can still own a namespace', () => {
    const reg = makeRegistry();
    const logger = makeCapturingLogger();
    reg.setLogger(logger);

    // No packageName — should be treated as '__unknown__'
    const first  = makePluginCmd('tools', 'build', undefined);
    const second = makePluginCmd('tools', 'lint',  undefined);
    reg.registerManifest(first);
    reg.registerManifest(second);

    // Both undefined → same '__unknown__' owner → co-fill allowed
    expect(first.shadowed).toBe(false);
    expect(second.shadowed).toBe(false);
  });

  it('warning message contains both the owner name and the intruder name', () => {
    const reg = makeRegistry();
    const logger = makeCapturingLogger();
    reg.setLogger(logger);

    const owner   = makePluginCmd('analytics', 'report', '@kb-labs/analytics');
    const intruder = makePluginCmd('analytics', 'hijack', '@evil/bad-plugin');
    reg.registerManifest(owner);
    reg.registerManifest(intruder);

    expect(logger.warns.length).toBeGreaterThanOrEqual(1);
    const warn = logger.warns[0]!;
    expect(warn).toContain('@evil/bad-plugin');
    expect(warn).toContain('@kb-labs/analytics');
  });
});

// ─── Validation (path guards) ─────────────────────────────────────────────────

describe('Validation', () => {
  it('empty segments path → command is shadowed and a warning is emitted', () => {
    const reg = makeRegistry();
    const logger = makeCapturingLogger();
    reg.setLogger(logger);

    // Manufacture a command with empty segments (bypass TypeScript to simulate a bad manifest)
    const cmd: RegisteredCommand = {
      manifest: {
        manifestVersion: '1.0',
        segments: [],
        id: '',
        group: '',
        describe: 'Bad command',
        loader: async () => ({ run: async () => 0 }),
      },
      available: true,
      source: 'workspace',
      shadowed: false,
    };
    reg.registerManifest(cmd);

    expect(cmd.shadowed).toBe(true);
    expect(logger.warns.length).toBeGreaterThanOrEqual(1);
  });

  it('path starting with reserved namespace __complete is blocked', () => {
    const reg = makeRegistry();
    const logger = makeCapturingLogger();
    reg.setLogger(logger);

    const cmd: RegisteredCommand = {
      manifest: {
        manifestVersion: '1.0',
        segments: ['__complete', 'hijack'],
        id: 'hijack',
        group: '__complete',
        describe: 'Attempts to hijack completion',
        loader: async () => ({ run: async () => 0 }),
      },
      available: true,
      source: 'workspace',
      shadowed: false,
    };
    reg.registerManifest(cmd);

    expect(cmd.shadowed).toBe(true);
    expect(logger.warns.some(w => w.includes('__complete'))).toBe(true);
  });

  it('path depth exceeding MAX_PATH_DEPTH (6) is blocked', () => {
    const reg = makeRegistry();
    const logger = makeCapturingLogger();
    reg.setLogger(logger);

    const cmd: RegisteredCommand = {
      manifest: {
        manifestVersion: '1.0',
        segments: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],  // 7 segments — over the limit
        id: 'g',
        group: 'a',
        describe: 'Too deep',
        loader: async () => ({ run: async () => 0 }),
      },
      available: true,
      source: 'workspace',
      shadowed: false,
    };
    reg.registerManifest(cmd);

    expect(cmd.shadowed).toBe(true);
    expect(logger.warns.some(w => w.includes('too deep') || w.includes('path'))).toBe(true);
  });

  it('valid path passes all guards and registers successfully', () => {
    const reg = makeRegistry();
    const logger = makeCapturingLogger();
    reg.setLogger(logger);

    const cmd: RegisteredCommand = {
      manifest: {
        manifestVersion: '1.0',
        segments: ['tools', 'format'],
        id: 'format',
        group: 'tools',
        describe: 'Format command',
        loader: async () => ({ run: async () => 0 }),
      },
      packageName: '@kb-labs/tools',
      available: true,
      source: 'workspace',
      shadowed: false,
    };
    reg.registerManifest(cmd);

    expect(cmd.shadowed).toBe(false);
    expect(logger.warns).toHaveLength(0);

    const result = reg.resolve(['tools', 'format']);
    expect(result.type).toBe('command');
  });
});
