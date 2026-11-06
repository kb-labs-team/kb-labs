import { describe, expect, it } from 'vitest';
import { registerBuiltinSystemCommands } from '../utils/register';
import { registry } from './service';

describe('system command scope declarations', () => {
  // case: S-124.10
  it('declares scope on every command in the live system registry', async () => {
    registerBuiltinSystemCommands();
    const commands = registry.listSystemCommands();

    expect(commands.length).toBeGreaterThan(0);
    expect(commands.every((command) => typeof command.scope === 'function'
      || command.scope === 'platform' || command.scope === 'project')).toBe(true);

    expect(registry.resolve(['hello'])).toMatchObject({ type: 'system-cmd', cmd: { scope: 'platform' } });
    expect(registry.resolve(['logs', 'query'])).toMatchObject({ type: 'system-cmd', cmd: { scope: 'platform' } });
    for (const name of ['register', 'status', 'list']) {
      expect(registry.resolve(['workspace', name])).toMatchObject({
        type: 'system-cmd', cmd: { scope: 'platform' },
      });
    }
    expect(registry.resolve(['mcp', 'config'])).toMatchObject({ type: 'system-cmd', cmd: { scope: 'project' } });
    expect(registry.resolve(['docs', 'generate-cli-reference'])).toMatchObject({
      type: 'system-cmd', cmd: { scope: 'project' },
    });
    expect(registry.resolve(['scaffold', 'run'])).toMatchObject({
      type: 'system-cmd', cmd: { scope: 'project' },
    });
    expect(registry.resolve(['scaffold', 'doctor'])).toMatchObject({
      type: 'system-cmd', cmd: { scope: 'project' },
    });
    for (const name of ['get', 'set', 'show']) {
      expect(registry.resolve(['config', name])).toMatchObject({
        type: 'system-cmd', cmd: { scope: 'project' },
      });
    }
  });
});
