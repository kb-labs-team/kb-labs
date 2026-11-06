import { builtinModules } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const compilerOptions = {
  allowJs: true,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  resolvePackageJsonExports: true,
};

export function nodeEnginePrebuildEntry(workspaceRoot) {
  return path.join(path.resolve(workspaceRoot), 'core/plugin-runtime/src/platform-resolve/node-engine.mjs');
}

export function inspectPrebuildImportGraph(entrypoint, workspaceRoot) {
  const root = path.resolve(workspaceRoot);
  const pending = [path.resolve(entrypoint)];
  const visited = new Set();
  const issues = [];

  while (pending.length > 0) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    visited.add(file);

    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    for (const specifier of moduleSpecifiers(source)) {
      if (builtins.has(specifier)) continue;
      const resolution = ts.resolveModuleName(specifier, file, compilerOptions, ts.sys).resolvedModule;
      const resolved = resolution && path.resolve(resolution.resolvedFileName);
      if (!resolved) {
        issues.push({ file, specifier, resolved: undefined });
        continue;
      }
      const relative = path.relative(root, resolved);
      if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative) || relative.split(path.sep).includes('dist')) {
        issues.push({ file, specifier, resolved });
        continue;
      }
      if (!resolved.endsWith('.d.ts') && !resolved.endsWith('.d.mts') && !resolved.endsWith('.d.cts')) pending.push(resolved);
    }
  }

  return issues;
}

function moduleSpecifiers(source) {
  const specifiers = [];
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.kind === ts.SyntaxKind.Identifier && node.expression.text === 'require') && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return specifiers;
}
