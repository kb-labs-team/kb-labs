import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { nodeEnginePrebuildEntry } from './prebuild-imports.mjs';

const require = createRequire(import.meta.url);
const tscPath = path.join(path.dirname(require.resolve('typescript')), 'tsc.js');
const regenerateCommand = 'corepack pnpm exec node scripts/checks/generate-authored-esm-declarations.mjs';

export function discoverAuthoredEsmDeclarations(workspacePackages, workspaceRoot) {
  const pairs = new Map();
  const packagesByRoot = [];
  for (const workspacePackage of workspacePackages) {
    const packageRoot = path.resolve(workspacePackage.dir);
    const manifestPath = path.join(packageRoot, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const configPath = ts.findConfigFile(packageRoot, ts.sys.fileExists, 'tsconfig.json');
    const config = configPath ? ts.readConfigFile(configPath, ts.sys.readFile) : undefined;
    if (config?.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
    const parsed = configPath && config
      ? ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath), {}, configPath)
      : undefined;
    if (parsed?.errors.length) {
      throw new Error(parsed.errors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')).join('\n'));
    }
    const sourceRoot = path.resolve(parsed?.options.rootDir ?? path.join(packageRoot, 'src'));
    packagesByRoot.push({ packageRoot, sourceRoot, configPath, parsed });

    for (const exportValue of Object.values(manifest.exports ?? {})) {
      for (const exported of sourceExportPairs(exportValue)) {
        const source = path.resolve(packageRoot, exported.importPath);
        const declaration = path.resolve(packageRoot, exported.typesPath);
        if (!existsSync(source)) throw new Error(`${source} is exported as authored ESM but does not exist.`);
        addPair(pairs, { packageRoot, sourceRoot, source, declaration });
      }
    }
  }

  const prebuildEntry = nodeEnginePrebuildEntry(workspaceRoot);
  const prebuildOwner = packagesByRoot
    .filter(({ packageRoot }) => prebuildEntry.startsWith(`${packageRoot}${path.sep}`))
    .sort((left, right) => right.packageRoot.length - left.packageRoot.length)[0];
  if (prebuildOwner?.parsed) {
    for (const projectFile of prebuildOwner.parsed.fileNames) {
      const sourceFile = ts.createSourceFile(projectFile, readFileSync(projectFile, 'utf8'), ts.ScriptTarget.Latest, true);
      for (const specifier of moduleSpecifiers(sourceFile)) {
        const resolved = ts.resolveModuleName(specifier, projectFile, prebuildOwner.parsed.options, ts.sys).resolvedModule;
        if (!resolved?.resolvedFileName.endsWith('.d.mts')) continue;
        const declaration = path.resolve(resolved.resolvedFileName);
        const source = `${declaration.slice(0, -6)}.mjs`;
        const relativeSource = path.relative(prebuildOwner.sourceRoot, source);
        if (!existsSync(source) || relativeSource.startsWith(`..${path.sep}`) || path.isAbsolute(relativeSource)) continue;
        addPair(pairs, { packageRoot: prebuildOwner.packageRoot, sourceRoot: prebuildOwner.sourceRoot, source, declaration });
      }
    }
  }
  return [...pairs.values()].sort((left, right) => left.declaration.localeCompare(right.declaration));
}

export function checkAuthoredEsmDeclarationDrift(workspacePackages, workspaceRoot) {
  const pairs = discoverAuthoredEsmDeclarations(workspacePackages, workspaceRoot);
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'kb-authored-esm-declarations-'));
  const issues = [];
  try {
    for (const [index, pair] of pairs.entries()) {
      const outputRoot = path.join(temporaryRoot, String(index));
      const result = compile(pair, workspaceRoot, outputRoot, true);
      if (result.status !== 0) {
        issues.push({
          file: pair.source,
          message: `Authored ESM source type-check or declaration generation failed: ${commandOutput(result)}. Fix JSDoc in the source, then regenerate with: ${regenerateCommand}`,
        });
        continue;
      }
      const generatedDeclaration = path.join(outputRoot, path.relative(pair.sourceRoot, pair.source).slice(0, -4) + '.d.mts');
      if (!existsSync(generatedDeclaration)) {
        issues.push({
          file: pair.declaration,
          message: `TypeScript did not generate the declaration for ${pair.source}; regenerate with: ${regenerateCommand}`,
        });
        continue;
      }
      const generated = readFileSync(generatedDeclaration);
      if (!existsSync(pair.declaration) || !generated.equals(readFileSync(pair.declaration))) {
        issues.push({
          file: pair.declaration,
          message: `Authored ESM declaration differs from its generated output; regenerate with: ${regenerateCommand}`,
        });
      }
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
  return issues;
}

export function regenerateAuthoredEsmDeclarations(workspacePackages, workspaceRoot) {
  const pairs = discoverAuthoredEsmDeclarations(workspacePackages, workspaceRoot);
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'kb-authored-esm-regenerate-'));
  try {
    for (const [index, pair] of pairs.entries()) {
      const outputRoot = path.join(temporaryRoot, String(index));
      const result = compile(pair, workspaceRoot, outputRoot, true);
      if (result.status !== 0) {
        throw new Error(`Cannot generate ${pair.declaration}: ${commandOutput(result)}`);
      }
      const generatedDeclaration = path.join(outputRoot, path.relative(pair.sourceRoot, pair.source).slice(0, -4) + '.d.mts');
      if (!existsSync(generatedDeclaration)) throw new Error(`TypeScript did not generate the declaration for ${pair.source}.`);
      const declaration = readFileSync(generatedDeclaration);
      writeFileSync(pair.declaration, declaration);
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
  return pairs.map((pair) => pair.declaration);
}

export function typeCheckAuthoredEsmSources(workspacePackages, workspaceRoot) {
  const pairs = discoverAuthoredEsmDeclarations(workspacePackages, workspaceRoot);
  const issues = [];
  for (const pair of pairs) {
    const result = compile(pair, workspaceRoot, undefined, false);
    if (result.status !== 0) {
      issues.push({ file: pair.source, message: commandOutput(result) });
    }
  }
  return issues;
}

function compile(pair, workspaceRoot, outputRoot, emitDeclaration) {
  const args = [
    tscPath,
    '--allowJs',
    '--checkJs',
    '--strict',
    '--skipLibCheck',
    '--target', 'ES2022',
    '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext',
    '--types', 'node',
    '--typeRoots', path.join(workspaceRoot, 'node_modules/@types'),
  ];
  if (emitDeclaration) {
    args.push('--declaration', '--emitDeclarationOnly', '--rootDir', pair.sourceRoot, '--outDir', outputRoot);
  } else {
    args.push('--noEmit');
  }
  args.push(pair.source);
  return spawnSync(process.execPath, args, { cwd: pair.packageRoot, encoding: 'utf8' });
}

function sourceExportPairs(value) {
  const pairs = [];
  if (Array.isArray(value)) {
    for (const item of value) pairs.push(...sourceExportPairs(item));
  } else if (value && typeof value === 'object') {
    if (typeof value.import === 'string' && value.import.endsWith('.mjs')
      && typeof value.types === 'string' && value.types.endsWith('.d.mts')) {
      pairs.push({ importPath: value.import, typesPath: value.types });
    }
    for (const [condition, nested] of Object.entries(value)) {
      if (condition !== 'import' && condition !== 'types') pairs.push(...sourceExportPairs(nested));
    }
  }
  return pairs;
}

function moduleSpecifiers(source) {
  const specifiers = [];
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return specifiers;
}

function declarationFor(source) {
  return `${source.slice(0, -4)}.d.mts`;
}

function addPair(pairs, pair) {
  pairs.set(pair.declaration, pair);
}

function commandOutput(result) {
  return [result.stdout, result.stderr].filter(Boolean).join('\n').trim() || `tsc exited with status ${result.status}`;
}
