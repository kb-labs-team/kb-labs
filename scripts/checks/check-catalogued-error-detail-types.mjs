#!/usr/bin/env node
import { writeCheckResult } from './lib/check-result.mjs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

const input = JSON.parse(await readStdin());
const checkName = input.check;
const root = input.workspaceRoot;
const packages = input.workspace?.packages;
const issues = [];
if (typeof root !== 'string' || !Array.isArray(packages)) {
  writeCheckResult([{ check: checkName, severity: 'error', message: 'catalogued error detail rail requires kb-devkit workspace package data', file: root ?? '.' }]);
  process.exit(0);
}

const catalog = JSON.parse(await readFile(path.join(root, 'core/platform/src/error-envelope/errors.catalog.json'), 'utf8'));
const catalogCodes = new Set(catalog.codes.map((entry) => entry.code));
const registeredPackages = new Set(packages.filter((pkg) => typeof pkg.dir === 'string').map((pkg) => path.resolve(root, pkg.dir)));
const scannedPackages = new Set();
const sourceFiles = new Set();
const excludedDirectories = new Set(['node_modules', 'dist', 'coverage', '.git', '.turbo', '.next']);

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!excludedDirectories.has(entry.name)) await walk(fullPath);
    } else if (entry.isFile() && /\.(?:ts|tsx|mts|cts)$/.test(entry.name)) {
      sourceFiles.add(path.resolve(fullPath));
    }
  }
}

for (const packageRoot of registeredPackages) {
  await walk(packageRoot);
  scannedPackages.add(packageRoot);
}
if (scannedPackages.size !== registeredPackages.size || [...registeredPackages].some((packageRoot) => !scannedPackages.has(packageRoot))) {
  issues.push({ check: checkName, severity: 'error', message: 'scanned package roots do not match kb-devkit workspace package roots', file: root });
}

const program = ts.createProgram({
  rootNames: [...sourceFiles],
  options: {
    allowJs: false,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    jsx: ts.JsxEmit.ReactJSX,
    resolveJsonModule: true,
  },
});
const checker = program.getTypeChecker();
const parsedFiles = new Set(program.getSourceFiles().map((sourceFile) => path.resolve(sourceFile.fileName)).filter((fileName) => sourceFiles.has(fileName)));
if (parsedFiles.size !== sourceFiles.size || [...sourceFiles].some((fileName) => !parsedFiles.has(fileName))) {
  issues.push({ check: checkName, severity: 'error', message: 'TypeScript program did not include the complete discovered source set', file: root });
}

function baseType(type) {
  return checker.getBaseConstraintOfType(type) ?? type;
}

function containsOnlyCataloguedCodes(type, seen = new Set()) {
  if (!type || seen.has(type)) return false;
  seen.add(type);
  const constrained = baseType(type);
  if (constrained !== type) return containsOnlyCataloguedCodes(constrained, seen);
  if (constrained.isUnion()) {
    const codeMembers = constrained.types.filter((member) => (member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Never)) === 0);
    return codeMembers.length > 0 && codeMembers.every((member) => containsOnlyCataloguedCodes(member, seen));
  }
  if (constrained.isIntersection()) return constrained.types.some((member) => containsOnlyCataloguedCodes(member, seen));
  if ((constrained.flags & ts.TypeFlags.StringLiteral) !== 0) return catalogCodes.has(constrained.value);
  return false;
}

function hasOpenStringMap(type, seen = new Set()) {
  if (!type || seen.has(type)) return false;
  seen.add(type);
  const constrained = baseType(type);
  if (constrained !== type && hasOpenStringMap(constrained, seen)) return true;
  if (constrained.isUnionOrIntersection()) return constrained.types.some((member) => hasOpenStringMap(member, seen));
  const indexType = checker.getIndexTypeOfType(constrained, ts.IndexKind.String);
  if (!indexType) return false;
  const indexBase = baseType(indexType);
  return (indexBase.flags & ts.TypeFlags.Never) === 0;
}

function locationOf(node, sourceFile) {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { file: sourceFile.fileName, line: position.line + 1 };
}

function report(node, sourceFile, detail) {
  const location = locationOf(node, sourceFile);
  issues.push({
    check: checkName,
    severity: 'error',
    message: `catalogued error code is paired with an open string map in ${detail}`,
    ...location,
  });
}

function hasUnsafeCodeDetails(type, location) {
  for (const variant of type.isUnion() ? type.types : [type]) {
    const codeProperty = checker.getPropertyOfType(variant, 'code');
    const detailProperty = checker.getPropertyOfType(variant, 'details');
    if (!codeProperty || !detailProperty) continue;
    const codeType = checker.getTypeOfSymbolAtLocation(codeProperty, location);
    const detailsType = checker.getTypeOfSymbolAtLocation(detailProperty, location);
    if (containsOnlyCataloguedCodes(codeType) && hasOpenStringMap(detailsType)) return true;
  }
  return false;
}

function inspectObjectType(node, sourceFile) {
  let type;
  if (ts.isTypeAliasDeclaration(node)) type = checker.getTypeFromTypeNode(node.type);
  else if ((ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node)) && node.name) type = checker.getTypeAtLocation(node.name);
  if (type && hasUnsafeCodeDetails(type, node)) {
    report(node.name ?? node, sourceFile, 'a code/details object contract');
  }
}

function inspectSignature(declaration, sourceFile) {
  const signature = checker.getSignatureFromDeclaration(declaration);
  if (!signature) return;
  const parameters = signature.getParameters().map((parameter) => ({
    name: parameter.getName(),
    type: checker.getTypeOfSymbolAtLocation(parameter, declaration),
  }));
  const codeParameters = parameters.filter(({ name, type }) => name === 'code' && containsOnlyCataloguedCodes(type));
  const detailParameters = parameters.filter(({ name, type }) => name === 'details' && hasOpenStringMap(type));
  const codeParameterPairsWithOptions = codeParameters.length > 0 && parameters.some(({ name, type }) =>
    name !== 'code' && hasOpenStringMap(checker.getTypeOfPropertyOfType(type, 'details')),
  );
  const pairedObject = parameters.some(({ type }) => hasUnsafeCodeDetails(type, declaration));
  const unsafeReturn = hasUnsafeCodeDetails(signature.getReturnType(), declaration);
  if ((codeParameters.length > 0 && detailParameters.length > 0) || codeParameterPairsWithOptions || pairedObject || unsafeReturn) {
    report(declaration, sourceFile, 'a function signature');
  }
}

for (const sourceFile of program.getSourceFiles()) {
  if (!sourceFiles.has(path.resolve(sourceFile.fileName))) continue;
  function visit(node) {
    if (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node)) {
      inspectObjectType(node, sourceFile);
    }
    if (
      ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isMethodSignature(node) ||
      ts.isConstructorDeclaration(node) || ts.isCallSignatureDeclaration(node) || ts.isFunctionTypeNode(node)
    ) {
      inspectSignature(node, sourceFile);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
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
