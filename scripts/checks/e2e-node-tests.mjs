import { writeCheckResult } from './lib/check-result.mjs';
import { readFileSync, readdirSync } from 'node:fs';
import { glob } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

function sourceImportsNodeTest(file) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let found = false;
  const visit = node => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === 'node:test') {
      found = true;
    }
    if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const callee = node.expression;
      const isImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
      const arg = node.arguments[0];
      if ((isImport || isRequire) && ts.isStringLiteral(arg) && arg.text === 'node:test') found = true;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function shellWords(command) {
  const words = [];
  let word = '';
  let quote = '';
  let escaped = false;
  for (const char of command) {
    if (escaped) {
      word += char;
      escaped = false;
    } else if (char === '\\' && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (char === quote) quote = '';
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (/\s/.test(char)) {
      if (word) words.push(word);
      word = '';
    } else {
      word += char;
    }
  }
  if (escaped || quote) throw new Error(`Unterminated shell word in package test script: ${command}`);
  if (word) words.push(word);
  return words;
}

function packageTestPatterns(script) {
  const words = shellWords(script ?? '');
  const testIndex = words.indexOf('--test');
  if (testIndex < 0 || !words.slice(0, testIndex).some(word => word === 'node' || word.endsWith('/node'))) return [];
  return words.slice(testIndex + 1).filter(word => !word.startsWith('-') && !['&&', '||', ';'].includes(word));
}

function walk(directory, visit) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path, visit);
    else if (entry.isFile()) visit(path);
  }
}

function packageManifests(e2eRoot) {
  const manifests = [];
  walk(e2eRoot, path => {
    if (path.endsWith('/package.json')) manifests.push(path);
  });
  return manifests;
}

export async function e2eNodeTestIssues(root) {
  const absoluteRoot = resolve(root);
  const e2eRoot = join(absoluteRoot, 'e2e');
  const covered = new Set();
  for (const manifestPath of packageManifests(e2eRoot)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const packageDir = dirname(manifestPath);
    for (const pattern of packageTestPatterns(manifest.scripts?.test)) {
      for await (const match of glob(pattern, { cwd: packageDir, nodir: true })) {
        covered.add(resolve(packageDir, match));
      }
    }
  }

  const issues = [];
  walk(e2eRoot, path => {
    if (!new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']).has(extname(path)) || !sourceImportsNodeTest(path) || covered.has(resolve(path))) return;
    issues.push({
      check: 'e2e-node-tests',
      severity: 'error',
      message: 'This node:test file is not selected by any e2e workspace package test script.',
      file: relative(absoluteRoot, path),
    });
  });
  return issues.sort((left, right) => left.file.localeCompare(right.file));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const root = input.workspaceRoot ?? input.WorkspaceRoot;
  writeCheckResult(await e2eNodeTestIssues(root));
}
