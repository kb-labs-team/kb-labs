/**
 * Reserved namespace enforcement in TrieBackedRegistry.registerManifest
 * (tiers S/V/F/R, 06-command-naming §8). ADR-0018 ownership is covered in collision.test.ts.
 */

import { describe, it, expect } from 'vitest';
import type { ILogger } from '@kb-labs/core-platform';
import { TrieBackedRegistry } from '../service';
import type { RegisteredCommand } from '../types';

function makeCapturingLogger(): ILogger & { warns: string[] } {
  const warns: string[] = [];
  const logger = {
    warns,
    debug: () => {},
    info: () => {},
    warn: (msg: string) => { warns.push(msg); },
    error: () => {},
    child: () => logger,
  } as unknown as ILogger & { warns: string[] };
  return logger;
}

function makePluginCmd(group: string, id: string, packageName?: string, aliases?: string[]): RegisteredCommand {
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

function register(ns: string, pkg: string | undefined, aliases?: string[]) {
  const reg = new TrieBackedRegistry();
  const logger = makeCapturingLogger();
  reg.setLogger(logger);
  const cmd = makePluginCmd(ns, 'go', pkg, aliases);
  reg.registerManifest(cmd);
  return { cmd, logger, reg };
}

describe('Reserved namespaces in registerManifest', () => {
  it.each([
    ['S', 'project'],
    ['V', 'doctor'],
    ['F', 'commit'],
    ['R', 'user'],
  ])('tier %s: third-party namespace "%s" is rejected with a suggestion', (_tier, ns) => {
    const { cmd, logger } = register(ns, '@acme/tools');
    expect(cmd.shadowed).toBe(true);
    expect(logger.warns).toHaveLength(1);
    expect(logger.warns[0]).toContain(`Namespace "${ns}"`);
    expect(logger.warns[0]).toContain(`"acme-${ns}"`);
  });

  it('tier F: allowed for @kb-labs/* packages', () => {
    const { cmd, logger } = register('commit', '@kb-labs/commit-cli');
    expect(cmd.shadowed).toBe(false);
    expect(logger.warns).toHaveLength(0);
  });

  it('tiers S/V/R stay rejected even for @kb-labs/* packages', () => {
    for (const ns of ['project', 'doctor', 'user']) {
      expect(register(ns, '@kb-labs/x').cmd.shadowed).toBe(true);
    }
  });

  it('a reserved-name alias is skipped but the command is kept', () => {
    const { cmd, logger, reg } = register('acme-tools', '@acme/tools', ['doctor go']);
    expect(cmd.shadowed).toBe(false);
    expect(logger.warns.some(w => w.includes('alias "doctor go"'))).toBe(true);
    expect(reg.resolve(['doctor', 'go']).type).not.toBe('command');
  });

  it('non-reserved third-party namespace still registers', () => {
    expect(register('acme-user', '@acme/tools').cmd.shadowed).toBe(false);
  });
});
