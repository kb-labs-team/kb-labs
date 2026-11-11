import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const forbiddenBuiltins = new Set(builtinModules.flatMap((name) => [name, name.replace(/^node:/, '')]));

function importsOf(source: string): string[] {
  return [...source.matchAll(/(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g)]
    .map((match) => match[1] ?? '');
}

function sourcePathForImport(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) {
    const builtin = specifier.replace(/^node:/, '').split('/')[0] ?? '';
    expect(forbiddenBuiltins.has(builtin), `${from} imports Node built-in ${specifier}`).toBe(false);
    return undefined;
  }

  const target = resolve(dirname(from), specifier);
  const extension = extname(target);
  if (extension === '.json') {return undefined;}
  if (extension === '.js') {return target.slice(0, -3) + '.ts';}
  if (extension === '.ts') {return target;}
  return join(target, 'index.ts');
}

function walkModuleGraph(entry: string): Set<string> {
  const visited = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || visited.has(current)) {continue;}
    visited.add(current);
    const source = readFileSync(current, 'utf8');
    for (const specifier of importsOf(source)) {
      const imported = sourcePathForImport(current, specifier);
      if (imported) {pending.push(imported);}
    }
  }
  return visited;
}

describe('browser-safe core-platform entries', () => {
  // case: S-203.5
  it('keeps the error-envelope package subpath free of Node built-ins', () => {
    const graph = walkModuleGraph(join(packageRoot, 'src/error-envelope/index.ts'));
    expect(graph).toContain(join(packageRoot, 'src/error-envelope/validate.ts'));
  });

  // case: S-203.5
  it('keeps the UX-result package subpath free of Node built-ins', () => {
    const graph = walkModuleGraph(join(packageRoot, 'src/ux-result/index.ts'));
    expect(graph).toContain(join(packageRoot, 'src/error-envelope/validate.ts'));
  });
});
