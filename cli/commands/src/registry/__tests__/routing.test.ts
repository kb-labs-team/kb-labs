/**
 * Registry Routing Tests
 *
 * Covers canonical ID strategy, alias resolution, collision handling,
 * and all command path variants (bare, group:id, group:subgroup:id).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TrieBackedRegistry } from '../service';
import type { RegisteredCommand } from '../types';
import type { Command as SystemCommand, CommandGroup as SystemGroup } from '@kb-labs/shared-command-kit';
import type { ILogger } from '@kb-labs/core-platform';

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

function makeRegistry() {
  return new TrieBackedRegistry();
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

function makeSystemGroup(name: string, commands: string[]): SystemGroup {
  return {
    name,
    describe: `Group: ${name}`,
    commands: commands.map(c => makeSystemCmd(c)),
  };
}

function makePlugin(
  id: string,
  group: string,
  subgroup?: string,
  aliases?: string[],
): RegisteredCommand {
  const segments: string[] = group
    ? (subgroup ? [group, subgroup, id] : [group, id])
    : [id];
  return {
    manifest: {
      manifestVersion: '1.0',
      segments,
      id,
      group,
      subgroup,
      aliases,
      describe: `Plugin: ${id}`,
      loader: async () => ({ run: async () => 0 }),
    },
    // First-party package so tier-F reserved names (marketplace, commit, ...) are allowed
    packageName: '@kb-labs/test-plugin',
    available: true,
    source: 'workspace',
    shadowed: false,
  };
}

// ─── Canonical ID Strategy ────────────────────────────────────────────────────

describe('Canonical ID Strategy', () => {
  let reg: TrieBackedRegistry;
  beforeEach(() => { reg = makeRegistry(); });

  it('bare plugin (no group): canonical = id', () => {
    const plugin = makePlugin('my-tool', '');
    reg.registerManifest(plugin);

    const result = reg.resolve(['my-tool']);
    expect(result.type).toBe('command');
  });

  it('2-part plugin (group:id): canonical = group id', () => {
    const plugin = makePlugin('list', 'marketplace');
    reg.registerManifest(plugin);

    // Must be reachable via canonical tokens
    expect(reg.resolve(['marketplace', 'list']).type).toBe('command');
  });

  it('3-part plugin (group:subgroup:id): canonical = group subgroup id', () => {
    const plugin = makePlugin('list', 'marketplace', 'plugins');
    reg.registerManifest(plugin);

    // Full canonical
    expect(reg.resolve(['marketplace', 'plugins', 'list']).type).toBe('command');
  });
});

// ─── 2-Part Shorthand for 3-Part Commands ────────────────────────────────────

describe('2-Part Shorthand for 3-Part Commands', () => {
  let reg: TrieBackedRegistry;
  beforeEach(() => { reg = makeRegistry(); });

  it('suggests ["marketplace", "list"] as "did you mean" for 3-part command (unambiguous)', () => {
    const plugin = makePlugin('list', 'marketplace', 'plugins');
    reg.registerManifest(plugin);

    const result = reg.resolve(['marketplace', 'list']);
    // Shorthand is not auto-routed — returns not-found with suggestion
    expect(result.type).toBe('not-found');
    if (result.type === 'not-found') {
      expect(result.suggestions).toContain('marketplace plugins list');
    }
  });

  it('getCommandAt does NOT resolve 2-part shorthand (exact lookup only)', () => {
    const plugin = makePlugin('list', 'marketplace', 'plugins');
    reg.registerManifest(plugin);

    expect(reg.getCommandAt(['marketplace', 'list'])).toBeNull();
  });

  it('getCommandAt resolves via full canonical segments', () => {
    const plugin = makePlugin('list', 'marketplace', 'plugins');
    reg.registerManifest(plugin);

    const cmd = reg.getCommandAt(['marketplace', 'plugins', 'list']);
    expect(cmd).toBe(plugin);
  });
});

// ─── User-Defined Aliases ─────────────────────────────────────────────────────

describe('User-Defined Aliases', () => {
  let reg: TrieBackedRegistry;
  beforeEach(() => { reg = makeRegistry(); });

  it('resolves manifest aliases to the correct plugin', () => {
    const plugin = makePlugin('list', 'marketplace', 'plugins', ['mp list', 'mpl']);
    reg.registerManifest(plugin);

    // Bare alias
    expect(reg.resolve(['mpl']).type).toBe('command');
  });

  it('getCommandAt retrieves by canonical segments', () => {
    const plugin = makePlugin('list', 'marketplace', 'plugins', ['mpl']);
    reg.registerManifest(plugin);

    const cmd = reg.getCommandAt(['marketplace', 'plugins', 'list']);
    expect(cmd).toBe(plugin);
  });
});

// ─── Collision: System Always Wins ───────────────────────────────────────────

describe('Collision: System Always Wins', () => {
  let reg: TrieBackedRegistry;
  beforeEach(() => { reg = makeRegistry(); });

  it('system command beats plugin when canonical paths match exactly', () => {
    const group = makeSystemGroup('security', ['auth']);
    reg.registerGroup(group);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const plugin = makePlugin('auth', 'security');
    reg.registerManifest(plugin);

    expect(plugin.shadowed).toBe(true);
    const result = reg.resolve(['security', 'auth']);
    expect(result.type).toBe('system-cmd');
    warnSpy.mockRestore();
  });

  it('system bare command does NOT shadow plugin in different group', () => {
    const sys = makeSystemCmd('auth');
    reg.register(sys);

    const plugin = makePlugin('auth', 'security');
    reg.registerManifest(plugin);

    expect(plugin.shadowed).toBe(false);

    const pluginResult = reg.resolve(['security', 'auth']);
    expect(pluginResult.type).toBe('command');

    const sysResult = reg.resolve(['auth']);
    expect(sysResult.type).toBe('system-cmd');
  });

  it('system command beats plugin with same path', () => {
    const group = makeSystemGroup('marketplace', ['list']);
    reg.registerGroup(group);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const plugin = makePlugin('list', 'marketplace');
    reg.registerManifest(plugin);

    expect(plugin.shadowed).toBe(true);
    const result = reg.resolve(['marketplace', 'list']);
    expect(result.type).toBe('system-cmd');
    warnSpy.mockRestore();
  });

  it('system group beats plugin with same name', () => {
    const group = makeSystemGroup('marketplace', ['list', 'install']);
    reg.registerGroup(group);

    const result = reg.resolve(['marketplace']);
    expect(result.type).toBe('system-group');
    if (result.type === 'system-group') {
      expect(result.group).toHaveProperty('commands');
    }
  });

  it('logs warning when plugin collides with system command (same canonical)', () => {
    const logger = makeCapturingLogger();
    reg.setLogger(logger);

    const group = makeSystemGroup('sample', ['protected']);
    reg.registerGroup(group);

    const plugin = makePlugin('protected', 'sample');
    reg.registerManifest(plugin);

    expect(logger.warns.some(w => w.includes('collides with a system command') || w.includes('system'))).toBe(true);
  });

  it('shadowed plugin is stored in listCommands but not routed', () => {
    const sys = makeSystemCmd('deploy');
    reg.register(sys);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const plugin = makePlugin('deploy', 'infra');
    reg.registerManifest(plugin);

    // Listed in commands
    const cmds = reg.listCommands();
    expect(cmds).toContainEqual(plugin);

    // But not routed
    const result = reg.resolve(['deploy']);
    expect(result.type).toBe('system-cmd');
    warnSpy.mockRestore();
  });

  it('plugin alias that collides with system command is blocked', () => {
    const logger = makeCapturingLogger();
    reg.setLogger(logger);

    const sys = makeSystemCmd('sys-cmd', ['sc']);
    reg.register(sys);

    const plugin = makePlugin('plugin-cmd', 'sample', undefined, ['sc']);
    reg.registerManifest(plugin);

    expect(logger.warns.some(w => w.includes('"sc"') || w.includes('sc'))).toBe(true);
    // alias 'sc' still routes to system
    const result = reg.resolve(['sc']);
    expect(result.type).toBe('system-cmd');
    if (result.type === 'system-cmd') {
      expect(result.cmd).toBe(sys);
    }
  });
});

// ─── Group Routing ────────────────────────────────────────────────────────────

describe('Group Routing', () => {
  let reg: TrieBackedRegistry;
  beforeEach(() => { reg = makeRegistry(); });

  it('registered group returns type=system-group', () => {
    const group = makeSystemGroup('plugins', ['list', 'install']);
    reg.registerGroup(group);

    const result = reg.resolve(['plugins']);
    expect(result.type).toBe('system-group');
    if (result.type === 'system-group') {
      expect(result.group).toHaveProperty('commands');
    }
  });

  it('subcommand within group resolves to system-cmd', () => {
    const group = makeSystemGroup('info', ['hello', 'version']);
    reg.registerGroup(group);

    expect(reg.resolve(['info', 'hello']).type).toBe('system-cmd');
  });

  it('listCommandsUnder returns plugin commands under a group', () => {
    const plugin = makePlugin('list', 'marketplace', 'plugins');
    reg.registerManifest(plugin);

    const cmds = reg.listCommandsUnder(['marketplace']);
    expect(cmds.length).toBeGreaterThan(0);
    expect(cmds).toContainEqual(plugin);
  });
});

// ─── Command Namespace Routing ───────────────────────────────────────────────

describe('Command Namespace Routing', () => {
  it('prefers a multi-word command over a bare command namespace', () => {
    const reg = makeRegistry();
    const defaultCommand = makePlugin('commit', '');
    const openCommand = makePlugin('open', 'commit');
    reg.registerManifest(defaultCommand);
    reg.registerManifest(openCommand);

    const result = reg.resolve(['commit', 'open']);

    expect(result.type).toBe('command');
    if (result.type === 'command') {
      expect(result.command).toBe(openCommand);
      expect(result.rest).toEqual([]);
    }
  });

  it('falls back to the bare command when the next token is an argument', () => {
    const reg = makeRegistry();
    const defaultCommand = makePlugin('commit', '');
    const openCommand = makePlugin('open', 'commit');
    reg.registerManifest(defaultCommand);
    reg.registerManifest(openCommand);

    const result = reg.resolve(['commit', 'message']);

    expect(result.type).toBe('command');
    if (result.type === 'command') {
      expect(result.command).toBe(defaultCommand);
      expect(result.rest).toEqual(['message']);
    }
  });
});

// ─── Multi-Plugin Registration ────────────────────────────────────────────────

describe('Multiple Plugins in Same Group', () => {
  let reg: TrieBackedRegistry;
  beforeEach(() => { reg = makeRegistry(); });

  it('registers multiple commands under same group:subgroup', () => {
    const list = makePlugin('list', 'marketplace', 'plugins');
    const install = makePlugin('install', 'marketplace', 'plugins');
    reg.registerManifest(list);
    reg.registerManifest(install);

    expect(reg.resolve(['marketplace', 'plugins', 'list']).type).toBe('command');
    expect(reg.resolve(['marketplace', 'plugins', 'install']).type).toBe('command');
  });

  it('listCommands returns all unique plugins', () => {
    const list = makePlugin('list', 'marketplace', 'plugins');
    const install = makePlugin('install', 'marketplace', 'plugins');
    reg.registerManifest(list);
    reg.registerManifest(install);

    const cmds = reg.listCommands();
    expect(cmds).toHaveLength(2);
    expect(cmds).toContainEqual(list);
    expect(cmds).toContainEqual(install);
  });

  it('listCommandsUnder returns commands in that group', () => {
    const list = makePlugin('list', 'marketplace', 'plugins');
    const install = makePlugin('install', 'marketplace', 'plugins');
    reg.registerManifest(list);
    reg.registerManifest(install);

    const cmds = reg.listCommandsUnder(['marketplace']);
    expect(cmds).toHaveLength(2);
  });
});

// ─── Cross-Group Bare ID: No False Collisions ──────────────────────────────────

describe('Cross-Group Bare ID (no false collisions)', () => {
  let reg: TrieBackedRegistry;
  beforeEach(() => { reg = makeRegistry(); });

  it('different groups with same bare id do not collide', () => {
    const agentRun = makePlugin('run', 'agent');
    const workflowRun = makePlugin('run', 'workflow');
    const reviewRun = makePlugin('run', 'review');

    reg.registerManifest(agentRun);
    reg.registerManifest(workflowRun);
    reg.registerManifest(reviewRun);

    expect(reg.resolve(['agent', 'run']).type).toBe('command');
    expect(reg.resolve(['workflow', 'run']).type).toBe('command');
    expect(reg.resolve(['review', 'run']).type).toBe('command');

    // None should be shadowed
    expect(agentRun.shadowed).toBe(false);
    expect(workflowRun.shadowed).toBe(false);
    expect(reviewRun.shadowed).toBe(false);
  });

  it('system group bare subcommand does not shadow plugin with same bare id in different group', () => {
    const infoGroup = makeSystemGroup('info', ['health', 'version']);
    reg.registerGroup(infoGroup);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const workflowHealth = makePlugin('health', 'workflow');
    reg.registerManifest(workflowHealth);

    expect(workflowHealth.shadowed).toBe(false);
    expect(reg.resolve(['workflow', 'health']).type).toBe('command');

    // System still works via its own path
    expect(reg.resolve(['info', 'health']).type).toBe('system-cmd');

    warnSpy.mockRestore();
  });

  it('system bare command "status" does not shadow plugin group:status', () => {
    const authGroup = makeSystemGroup('auth', ['login', 'status']);
    reg.registerGroup(authGroup);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const workflowStatus = makePlugin('status', 'workflow');
    const devlinkStatus = makePlugin('status', 'devlink');
    reg.registerManifest(workflowStatus);
    reg.registerManifest(devlinkStatus);

    expect(workflowStatus.shadowed).toBe(false);
    expect(devlinkStatus.shadowed).toBe(false);
    expect(reg.resolve(['workflow', 'status']).type).toBe('command');
    expect(reg.resolve(['devlink', 'status']).type).toBe('command');

    warnSpy.mockRestore();
  });

  it('multiple plugins with same bare id are all listed in listCommands', () => {
    const agentRun = makePlugin('run', 'agent');
    const workflowRun = makePlugin('run', 'workflow');
    reg.registerManifest(agentRun);
    reg.registerManifest(workflowRun);

    const cmds = reg.listCommands();
    expect(cmds).toContainEqual(agentRun);
    expect(cmds).toContainEqual(workflowRun);
  });
});

// ─── Edge Cases ───────────────────────────────────────────────────────────────

describe('Edge Cases', () => {
  let reg: TrieBackedRegistry;
  beforeEach(() => { reg = makeRegistry(); });

  it('returns not-found for unknown command', () => {
    const result = reg.resolve(['non-existent-command']);
    expect(result.type).toBe('not-found');
  });

  it('getCommandAt returns non-null for registered plugin (full path)', () => {
    const plugin = makePlugin('list', 'marketplace', 'plugins');
    reg.registerManifest(plugin);

    expect(reg.getCommandAt(['marketplace', 'plugins', 'list'])).not.toBeNull();
  });

  it('getCommandAt returns null for 2-part shorthand (exact lookup only)', () => {
    const plugin = makePlugin('list', 'marketplace', 'plugins');
    reg.registerManifest(plugin);

    expect(reg.getCommandAt(['marketplace', 'list'])).toBeNull();
  });

  it('getCommandAt returns null for unknown command', () => {
    expect(reg.getCommandAt(['totally-unknown'])).toBeNull();
  });

  it('listCommands returns no duplicates for multiply-keyed commands', () => {
    const plugin = makePlugin('list', 'marketplace', 'plugins');
    reg.registerManifest(plugin);

    const cmds = reg.listCommands();
    const seen = new Set(cmds);
    expect(seen.size).toBe(cmds.length);
  });

  it('getCommandAt retrieves by canonical segments', () => {
    const plugin = makePlugin('list', 'marketplace', 'plugins');
    reg.registerManifest(plugin);

    expect(reg.getCommandAt(['marketplace', 'plugins', 'list'])).toBe(plugin);
  });
});
