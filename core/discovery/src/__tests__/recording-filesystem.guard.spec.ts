import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

const sourceRoot = path.resolve(import.meta.dirname, '..');
const facadePath = path.join(sourceRoot, 'recording-filesystem.ts');

function productionSources(entryPath: string): string[] {
  const sources = new Set<string>();
  const pending = [entryPath];
  while (pending.length > 0) {
    const filePath = pending.pop()!;
    if (sources.has(filePath)) {continue;}
    sources.add(filePath);
    const ast = ts.createSourceFile(filePath, ts.sys.readFile(filePath) ?? '', ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const specifiers: string[] = [];
    const visit = (node: ts.Node): void => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        specifiers.push(node.moduleSpecifier.text);
      }
      if (ts.isCallExpression(node) && node.arguments.length === 1 && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
          specifiers.push(node.arguments[0].text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    for (const specifier of specifiers) {
      const resolved = ts.resolveModuleName(specifier, filePath, { moduleResolution: ts.ModuleResolutionKind.NodeNext, module: ts.ModuleKind.NodeNext }, ts.sys).resolvedModule?.resolvedFileName;
      if (resolved && path.resolve(resolved).startsWith(`${sourceRoot}${path.sep}`) && !sources.has(path.resolve(resolved))) {pending.push(path.resolve(resolved));}
    }
  }
  return [...sources];
}

function importedModules(source: string, filePath: string): string[] {
  const ast = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const modules: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {modules.push(node.moduleSpecifier.text);}
    }
    const argument = ts.isCallExpression(node) && node.arguments.length === 1 ? node.arguments[0] : undefined;
    if (ts.isCallExpression(node) && argument && ts.isStringLiteral(argument)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (isDynamicImport || isRequire) {modules.push(argument.text);}
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return modules;
}

describe('discovery filesystem ownership', () => {
  it('routes every production filesystem and glob import through the recording facade', async () => {
    const files = productionSources(path.join(sourceRoot, 'index.ts'));
    const bypasses: string[] = [];
    for (const file of files) {
      if (file === facadePath) {continue;}
      const modules = importedModules(await readFile(file, 'utf8'), file);
      if (modules.some((specifier) => specifier === 'node:fs' || specifier.startsWith('node:fs/') || specifier === 'fs' || specifier === 'glob' || specifier === 'fast-glob')) {
        bypasses.push(path.relative(sourceRoot, file));
      }
    }
    expect(bypasses).toEqual([]);
  });
});
