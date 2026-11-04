import { beforeAll, describe, expect, it } from 'vitest';
import { errorCatalog } from '@kb-labs/core-platform/error-envelope';
import { registry, registerBuiltinCommands, registerBuiltinSystemCommands } from '@kb-labs/cli-commands';
import { parseArgs } from '@kb-labs/cli-runtime';
import { join } from 'node:path';

const workspaceRoot = join(import.meta.dirname, '../../../..');

beforeAll(async () => {
  registerBuiltinSystemCommands();
  await registerBuiltinCommands({ cwd: workspaceRoot, platformRoot: workspaceRoot, projectRoot: workspaceRoot, resolvePlatformVersion: async () => 'test' });
});

function commandSnippets(text: string): string[] {
  const quoted = [...text.matchAll(/["'`](kb\s+[^"'`]+)["'`]/g)].map((match) => match[1]!.trim());
  return text.startsWith('kb ') ? [text.trim(), ...quoted] : quoted;
}

function declaredFlags(route: ReturnType<typeof registry.resolve>): Set<string> {
  if (route.type === 'command') return new Set((route.command.manifest.flags ?? []).map((flag) => flag.name));
  if (route.type === 'system-cmd') return new Set((route.cmd.flags ?? []).map((flag) => flag.name));
  return new Set();
}

describe('error catalog recovery commands', () => {
  it('resolves each kb command and its flags against the registered CLI', () => {
    const problems: string[] = [];
    for (const entry of errorCatalog.codes) {
      for (const snippet of commandSnippets(entry.hint)) {
        const tokens = snippet.split(/\s+/).filter(Boolean);
        const parsed = parseArgs(tokens.slice(1));
        const route = registry.resolve(tokens.slice(1));
        if (route.type !== 'command' && route.type !== 'system-cmd') {
          if (parsed.cmdPath.length === 0 && parsed.global.help) continue;
          problems.push(`${entry.code}: command does not resolve: ${snippet}`);
          continue;
        }
        const flags = declaredFlags(route);
        for (const token of tokens.slice(1)) {
          if (!token.startsWith('--')) continue;
          const flag = token.slice(2).split('=')[0]!;
          if (!flags.has(flag) && !Object.hasOwn(parsed.global, flag)) {
            problems.push(`${entry.code}: --${flag} is not declared by ${snippet}`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
