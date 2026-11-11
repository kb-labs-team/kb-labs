#!/usr/bin/env node
import { writeCheckResult } from './lib/check-result.mjs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

const input = JSON.parse(await readStdin());
const checkName = input.check;
const issues = [];
const root = input.workspaceRoot;
const packages = input.workspace?.packages;
if (typeof root !== 'string' || !Array.isArray(packages)) {
  writeCheckResult([{ check: checkName, severity: 'error', message: 'workspace-scoped error-code catalog check requires package data on stdin', file: root ?? '.' }]);
  process.exit(0);
}

const catalogPath = path.join(root, 'core/platform/src/error-envelope/errors.catalog.json');
const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
const catalogCodes = new Set(catalog.codes.map((entry) => entry.code));
const registeredPackages = new Set();
const scannedPackages = new Set();
const sourceFiles = new Set();
const excludedDirectories = new Set(['node_modules', 'dist', 'coverage', '.git', '.turbo', 'test', 'tests', '__tests__', 'e2e', 'fixtures']);
const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.go']);

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!excludedDirectories.has(entry.name)) await walk(full);
    } else if (entry.isFile() && sourceExtensions.has(path.extname(entry.name)) && !isTestSource(entry.name)) {
      sourceFiles.add(full);
    }
  }
}

for (const pkg of packages) {
  if (typeof pkg.dir !== 'string') continue;
  const packageRoot = path.resolve(root, pkg.dir);
  registeredPackages.add(packageRoot);
  await walk(packageRoot);
  scannedPackages.add(packageRoot);
}
if (scannedPackages.size !== registeredPackages.size || [...registeredPackages].some((directory) => !scannedPackages.has(directory))) {
  issues.push({ check: checkName, severity: 'error', message: 'scanned package roots do not match kb-devkit workspace package roots', file: root });
}

const sourceSet = new Set([...sourceFiles].map((file) => path.resolve(file)));
const unresolvedCodes = new Map();
function report(code, sourceFile, node) {
  if (!catalogCodes.has(code)) {
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    const key = `${sourceFile.fileName}:${position.line + 1}:${code}`;
    unresolvedCodes.set(key, { code, file: sourceFile.fileName, line: position.line + 1 });
  }
}
function propertyName(name) {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
}
function literalCode(node) {
  return node && ts.isStringLiteralLike(node) && /^KB_[A-Z0-9]+(?:_[A-Z0-9]+)+$/.test(node.text) ? node.text : undefined;
}
function calleeName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}
function isDiagnosticCode(node) {
  let current = node.parent;
  while (current) {
    if (ts.isPropertyAssignment(current) && propertyName(current.name) === 'diagnostics') return true;
    current = current.parent;
  }
  return false;
}

function isTestSource(fileName) {
  return fileName.endsWith('_test.go') || /(?:\.test|\.spec|\.stories)\.[^.]+$/.test(fileName);
}

function scanGoSource(filePath, sourceText) {
  const goCodes = [];
  const addMatch = (code, index) => {
    const line = sourceText.slice(0, index).split('\n').length;
    goCodes.push({ code, line });
  };
  const literalPattern = /^KB_[A-Z0-9]+(?:_[A-Z0-9]+)+$/;
  const fieldPattern = /\bCode\s*:\s*"(KB_[A-Z0-9]+(?:_[A-Z0-9]+)+)"/g;
  for (const match of sourceText.matchAll(fieldPattern)) addMatch(match[1], match.index);
  const constructorPatterns = [
    /\bdiag\.New\s*\(\s*("KB_[A-Z0-9]+(?:_[A-Z0-9]+)+"|[A-Za-z_]\w*)/g,
    /\bdiag\.Wrap\s*\(\s*[^,]+,\s*("KB_[A-Z0-9]+(?:_[A-Z0-9]+)+"|[A-Za-z_]\w*)/g,
    /\b(?:contracts\.)?NewDiag\s*\(\s*("KB_[A-Z0-9]+(?:_[A-Z0-9]+)+"|[A-Za-z_]\w*)/g,
  ];
  const variableCodes = new Map();
  const variablePattern = /(?:\b(?:const|var)\s+([A-Za-z_]\w*)\s*(?:[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?\s*)?=|\b([A-Za-z_]\w*)\s*:=)\s*"(KB_[A-Z0-9]+(?:_[A-Z0-9]+)+)"/g;
  for (const match of sourceText.matchAll(variablePattern)) {
    variableCodes.set(match[1] ?? match[2], { code: match[3], index: match.index });
  }
  for (const pattern of constructorPatterns) {
    for (const match of sourceText.matchAll(pattern)) {
      const argument = match[1];
      const literal = argument.startsWith('"') ? argument.slice(1, -1) : undefined;
      if (literal && literalPattern.test(literal)) addMatch(literal, match.index);
      else if (variableCodes.has(argument)) {
        const binding = variableCodes.get(argument);
        addMatch(binding.code, binding.index);
      }
    }
  }
  for (const finding of goCodes) {
    if (!catalogCodes.has(finding.code)) {
      unresolvedCodes.set(`${filePath}:${finding.line}:${finding.code}`, {
        code: finding.code,
        file: filePath,
        line: finding.line,
      });
    }
  }
}

const scannedFiles = new Set();
for (const filePath of sourceSet) {
  const sourceText = await readFile(filePath, 'utf8');
  if (filePath.endsWith('.go')) {
    scanGoSource(filePath, sourceText);
    scannedFiles.add(path.resolve(filePath));
    continue;
  }
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, filePath.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  scannedFiles.add(path.resolve(filePath));
  const codeBindings = new Map();
  const codedConstructorArgs = new Map();
  function collect(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const code = node.initializer && literalCode(node.initializer);
      if (code) codeBindings.set(node.name.text, { code, declaration: node.initializer });
    }
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)) && node.parameters.length) {
      const codeIndex = node.parameters.findIndex((parameter) => propertyName(parameter.name) === 'code');
      if (codeIndex >= 0 && node.parent && ts.isClassDeclaration(node.parent) && node.parent.name) {
        codedConstructorArgs.set(node.parent.name.text, codeIndex);
      }
    }
    ts.forEachChild(node, collect);
  }
  collect(sourceFile);
  function visit(node) {
    if ((ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node)) && propertyName(node.name) === 'code' && !isDiagnosticCode(node)) {
      const code = literalCode(node.initializer);
      if (code) report(code, sourceFile, node.initializer);
      if (node.initializer && ts.isIdentifier(node.initializer)) {
        const binding = codeBindings.get(node.initializer.text);
        if (binding) report(binding.code, sourceFile, binding.declaration);
      }
    }
    if (ts.isShorthandPropertyAssignment(node)) {
      const binding = codeBindings.get(node.name.text);
      if (binding) report(binding.code, sourceFile, binding.declaration);
    }
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      if (name === 'createErrorEnvelope') {
        const code = node.arguments[0] && literalCode(node.arguments[0]);
        if (code) report(code, sourceFile, node.arguments[0]);
        if (node.arguments[0] && ts.isIdentifier(node.arguments[0])) {
          const binding = codeBindings.get(node.arguments[0].text);
          if (binding) report(binding.code, sourceFile, binding.declaration);
        }
      }
    }
    if (ts.isNewExpression(node)) {
      const name = calleeName(node.expression);
      const index = name && codedConstructorArgs.get(name);
      const arg = index !== undefined ? node.arguments?.[index] : undefined;
      const code = arg && literalCode(arg);
      if (code && arg) report(code, sourceFile, arg);
      if (arg && ts.isIdentifier(arg)) {
        const binding = codeBindings.get(arg.text);
        if (binding) report(binding.code, sourceFile, binding.declaration);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}
for (const finding of unresolvedCodes.values()) {
  issues.push({ check: checkName, severity: 'error', message: `${finding.code} is used as an error code but is absent from the platform catalog`, file: finding.file, line: finding.line });
}
if (scannedFiles.size !== sourceSet.size || [...sourceSet].some((filePath) => !scannedFiles.has(path.resolve(filePath)))) {
  issues.push({ check: checkName, severity: 'error', message: 'parsed source set does not match discovered source set', file: root });
}
writeCheckResult(issues);
function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}
