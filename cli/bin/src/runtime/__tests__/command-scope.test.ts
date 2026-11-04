import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { registerBuiltinSystemCommands, registry } from '@kb-labs/cli-commands';
import { resolveProjectScope } from '../command-scope';
import type { RegisteredCommand } from '@kb-labs/cli-commands';

describe('bootstrap command scope resolution', () => {
  it('resolves the current-project lookup before initializing platform adapters', () => {
    registerBuiltinSystemCommands();
    const route = registry.resolve(['project', 'show']);

    expect(route.type).toBe('system-cmd');
    if (route.type !== 'system-cmd') throw new Error('project show is not a system command');
    expect(resolveProjectScope(route, {}, ['project', 'show'])).toBe('required');

    const explicit = registry.resolve(['project', 'show', 'project-id']);
    expect(explicit.type).toBe('system-cmd');
    if (explicit.type !== 'system-cmd') throw new Error('project show with an ID is not a system command');
    expect(explicit.rest).toEqual(['project-id']);
    expect(resolveProjectScope(explicit, {}, ['project', 'show', 'project-id'])).toBe('platform');
  });

  // case: S-124.10
  it('uses each registered system command declaration and keeps plugins project-scoped', () => {
    registerBuiltinSystemCommands();
    const commands = registry.listSystemCommands();

    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(resolveProjectScope({ type: 'system-cmd', cmd: command, rest: [] }, {}, [])).toBe(
        command.scope === 'platform' ? 'platform' : 'required',
      );
    }
    const pluginCommand = {
      manifest: { schema: 'kb.adapter/1', manifestVersion: '1.0' as const, segments: ['demo'], id: 'demo', group: 'demo', describe: 'demo' },
      available: true,
      source: 'workspace' as const,
      shadowed: false,
    };
    expect(resolveProjectScope({ type: 'command', command: pluginCommand, rest: [] }, {}, ['demo'])).toBe('required');
    const marketplaceCommand = {
      ...pluginCommand,
      manifest: {
        ...pluginCommand.manifest,
        flags: [{ name: 'scope', type: 'string' as const, choices: ['platform', 'project'] }, { name: 'region', type: 'string' as const, choices: ['platform', 'project'] }],
      },
    } as RegisteredCommand;
    expect(resolveProjectScope({ type: 'command', command: marketplaceCommand, rest: [] }, {}, ['marketplace', 'install'], { scope: 'platform' })).toBe('platform');
    expect(resolveProjectScope({ type: 'command', command: marketplaceCommand, rest: [] }, {}, ['marketplace', 'install'], { scope: 'project' })).toBe('required');
    expect(resolveProjectScope({ type: 'command', command: marketplaceCommand, rest: [] }, {}, ['marketplace', 'install'], { region: 'platform' })).toBe('required');
    expect(resolveProjectScope({ type: 'not-found', input: [], suggestions: [] }, { help: true }, [])).toBe('platform');
    expect(resolveProjectScope({ type: 'not-found', input: [], suggestions: [] }, { version: true }, [])).toBe('platform');
    expect(resolveProjectScope({ type: 'not-found', input: ['missing'], suggestions: [] }, {}, ['missing'])).toBe('platform');
    expect(resolveProjectScope(
      { type: 'not-found', input: ['commit'], suggestions: [] },
      { help: true },
      ['commit'],
      {},
      true,
    )).toBe('required');
    expect(resolveProjectScope(
      { type: 'not-found', input: ['missing'], suggestions: [] },
      {},
      ['missing'],
      {},
      false,
    )).toBe('platform');
  });

  it('lets only registered platform/project scope selectors override project context', () => {
    registerBuiltinSystemCommands();
    for (const command of registry.listSystemCommands()) {
      const route = { type: 'system-cmd' as const, cmd: command, rest: [] };
      const scopeDefinition = command.flags?.find((flag) => flag.name === 'scope');
      if (scopeDefinition?.choices?.includes('platform') && scopeDefinition.choices.includes('project')) {
        expect(resolveProjectScope(route, {}, [], { scope: 'platform' })).toBe('platform');
        expect(resolveProjectScope(route, {}, [], { scope: 'project' })).toBe('required');
      }
      if (command.scope === 'platform') {
        expect(resolveProjectScope(route, {}, [])).toBe('platform');
      }
    }
  });

  it('keeps command-name policy out of bootstrap scope resolution', async () => {
    const source = await readFile(new URL('../bootstrap.ts', import.meta.url), 'utf8');
    const resolver = await readFile(new URL('../command-scope.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('usesPlatformScope');
    expect(source).toContain('resolveProjectScope');
    expect(resolver).not.toMatch(/cmdPath\[[^\]]+\]\s*===/);
    expect(resolver).not.toMatch(/(?:cmdPath\.(?:includes|some)|isPlatformAuthExempt)\([^)]*["'][^"']+["']/);
  });
});
