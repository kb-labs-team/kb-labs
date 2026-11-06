#!/usr/bin/env node
import { writeCheckResult } from './lib/check-result.mjs';
import { builtinModules } from 'node:module';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

function sourceFiles(directory) {
  if (!existsSync(directory)) return [];
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!['node_modules', 'dist', 'coverage', '__tests__', 'tests', 'test', 'fixtures'].includes(entry.name)) {
        result.push(...sourceFiles(file));
      }
    } else if (/\.(?:[cm]?[jt]sx?)$/.test(entry.name) && !/\.(?:test|spec)\.[^.]+$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      result.push(file);
    }
  }
  return result;
}

export function moduleSpecifiers(file, includeTypeOnly = false) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = [];
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && (includeTypeOnly || !node.importClause?.isTypeOnly) && ts.isStringLiteral(node.moduleSpecifier)) {
      const allBindingsAreTypes = node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
        && node.importClause.namedBindings.elements.length > 0
        && node.importClause.namedBindings.elements.every((element) => element.isTypeOnly);
      if (includeTypeOnly || !allBindingsAreTypes) found.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && (includeTypeOnly || !node.isTypeOnly) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      found.push(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node) && (includeTypeOnly || !node.isTypeOnly)
      && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)) {
      found.push(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      const callee = node.expression;
      if ((ts.isIdentifier(callee) && callee.text === 'require')
        || (callee.kind === ts.SyntaxKind.ImportKeyword)) found.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function packageEntry(pkg, subpath) {
  const exports = pkg.json.exports;
  const key = subpath ? `./${subpath}` : '.';
  let selected;
  if (exports && typeof exports === 'object') {
    selected = exports[key];
    if (selected === undefined) {
      return { kind: 'unexported-package-subpath', message: `${pkg.json.name} does not export ${key}` };
    }
    if (selected && typeof selected === 'object') {
      selected = selected.browser ?? selected.import ?? selected.default ?? selected.module;
    }
    if (typeof selected !== 'string') {
      return { kind: 'unexported-package-subpath', message: `${pkg.json.name} has no browser/import entry for ${key}` };
    }
  } else if (typeof exports === 'string') {
    selected = subpath ? undefined : exports;
    if (subpath) return { kind: 'unexported-package-subpath', message: `${pkg.json.name} does not export ${key}` };
  } else if (subpath) {
    selected = subpath;
  } else {
    selected = pkg.json.browser ?? pkg.json.module ?? pkg.json.main;
  }
  if (typeof selected !== 'string') {
    return { kind: 'unbuilt-package-entry', message: `${pkg.json.name} does not declare a built package entry` };
  }
  return { entry: path.resolve(pkg.absDir, selected) };
}

function existingModulePath(file) {
  const candidates = [file, `${file}.js`, `${file}.mjs`, `${file}.cjs`, path.join(file, 'index.js'), path.join(file, 'index.mjs')];
  return candidates.find((candidate) => existsSync(candidate) && !candidate.endsWith('.map'));
}

function builtinImport(specifier, builtins) {
  return builtins.has(specifier.replace(/^node:/, '')) ? specifier : undefined;
}

function workspaceName(specifier) {
  return specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
}

function declaresWorkspaceDependency(pkg, name) {
  return ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].some((field) => {
    const range = pkg.json[field]?.[name];
    return typeof range === 'string' && range.startsWith('workspace:');
  });
}

export function analyze(workspaceRoot, workspacePackages) {
  const workspace = path.resolve(workspaceRoot);
  const packages = workspacePackages.filter((pkg) => pkg.language === 'typescript').map((pkg) => {
    const absDir = path.resolve(workspace, pkg.dir);
    const json = JSON.parse(readFileSync(path.join(absDir, 'package.json'), 'utf8'));
    return { ...pkg, absDir, json, relDir: pkg.relDir ?? path.relative(workspace, absDir).split(path.sep).join('/') };
  });
  const byName = new Map(packages.map((pkg) => [pkg.json.name, pkg]));
  const builtins = new Set(builtinModules.flatMap((name) => [name, name.replace(/^node:/, '')]));
  const findings = [];
  const tracedEntries = new Set();
  const tracedFiles = new Set();
  const browserPackages = new Set();

  function finding(kind, fields) {
    return { rule: 'browser-node-builtins', kind, ...fields };
  }

  function traceBuiltGraph(entry, owner, seen = new Set()) {
    const resolved = existingModulePath(entry);
    if (!resolved) {
      return [finding('unbuilt-package-entry', {
        target: owner.json.name,
        file: path.relative(workspace, entry).split(path.sep).join('/'),
        fix: `Run kb-devkit run build --packages ${owner.json.name} to produce this entry.`,
        message: `${owner.json.name} has no built output at ${path.relative(workspace, entry).split(path.sep).join('/')}`,
      })];
    }
    if (seen.has(resolved)) return [];
    seen.add(resolved);
    tracedFiles.add(resolved);
    const issues = [];
    for (const specifier of moduleSpecifiers(resolved)) {
      const builtin = builtinImport(specifier, builtins);
      if (builtin) {
        issues.push(finding('node-builtin-in-built-output', {
          target: owner.json.name,
          builtin,
          file: path.relative(workspace, resolved).split(path.sep).join('/'),
          message: `${owner.json.name} built output imports Node builtin ${builtin}`,
        }));
        continue;
      }
      if (specifier.startsWith('.')) {
        const relativeEntry = path.resolve(path.dirname(resolved), specifier);
        if (!existingModulePath(relativeEntry)) {
          issues.push(finding('unresolved-relative-import', {
            target: specifier,
            file: path.relative(workspace, resolved).split(path.sep).join('/'),
            fix: `Run kb-devkit run build --packages ${owner.json.name} and ensure the imported module is included in the package output.`,
            message: `${path.relative(workspace, resolved).split(path.sep).join('/')} imports missing built module ${specifier}`,
          }));
          continue;
        }
        issues.push(...traceBuiltGraph(relativeEntry, owner, seen));
      } else if (!specifier.startsWith('/') && !specifier.startsWith('#')) {
        const name = workspaceName(specifier);
        const target = byName.get(name);
        if (!target) {
          if (declaresWorkspaceDependency(owner, name)) {
            issues.push(finding('unresolved-workspace-import', {
              target: specifier,
              file: path.relative(workspace, resolved).split(path.sep).join('/'),
              fix: `Register ${name} in the kb-devkit workspace package graph, then run kb-devkit check --json.`,
              message: `${owner.json.name} declares ${name} as a workspace dependency, but kb-devkit did not register that package`,
            }));
          }
          continue;
        }
        const importedSubpath = specifier.slice(name.length).replace(/^\//, '');
        const resolution = packageEntry(target, importedSubpath);
        if (!resolution.entry) {
          issues.push(finding(resolution.kind, {
            target: specifier,
            file: path.relative(workspace, resolved).split(path.sep).join('/'),
            fix: resolution.kind === 'unbuilt-package-entry'
              ? `Run kb-devkit run build --packages ${target.json.name} to produce its package entry.`
              : `Use a subpath exported by ${target.relDir}/package.json.`,
            message: resolution.message,
          }));
          continue;
        }
        const targetEntry = existingModulePath(resolution.entry);
        if (!targetEntry) {
          issues.push(finding('unbuilt-package-entry', {
            target: specifier,
            file: path.relative(workspace, resolved).split(path.sep).join('/'),
            fix: `Run kb-devkit run build --packages ${target.json.name} to produce its package entry.`,
            message: `${target.json.name} has no built output at ${path.relative(workspace, resolution.entry).split(path.sep).join('/')}`,
          }));
          continue;
        }
        tracedEntries.add(targetEntry);
        issues.push(...traceBuiltGraph(targetEntry, target, seen));
      }
    }
    return issues;
  }

  function recordIssue(issue, browserPkg, sourceFile, specifier) {
    const { file: graphFile, ...details } = issue;
    findings.push({
      ...details,
      package: browserPkg.relDir,
      file: path.relative(workspace, sourceFile).split(path.sep).join('/'),
      ...(graphFile ? { graphFile } : {}),
      target: issue.target ?? specifier,
    });
  }

  const browserSourceQueue = [];
  const queuedBrowserPackages = new Set();
  const addBrowserSource = (pkg, sourceRoot) => {
    if (queuedBrowserPackages.has(pkg.absDir)) return;
    queuedBrowserPackages.add(pkg.absDir);
    browserPackages.add(pkg.relDir);
    for (const sourceFile of sourceFiles(sourceRoot)) browserSourceQueue.push({ pkg, sourceFile });
  };

  for (const pkg of packages) {
    if (pkg.relDir === 'studio/app' && existsSync(path.join(pkg.absDir, 'src'))) {
      addBrowserSource(pkg, path.join(pkg.absDir, 'src'));
    } else if (pkg.relDir.startsWith('plugins/') && existsSync(path.join(pkg.absDir, 'src/studio'))) {
      addBrowserSource(pkg, path.join(pkg.absDir, 'src/studio'));
    }
  }

  while (browserSourceQueue.length > 0) {
    const { pkg: browserPkg, sourceFile } = browserSourceQueue.shift();
    for (const specifier of moduleSpecifiers(sourceFile)) {
      const builtin = builtinImport(specifier, builtins);
      if (builtin) {
        recordIssue(finding('direct-node-builtin', {
          builtin,
          fix: `Replace the Node builtin import ${builtin} with a browser-compatible API.`,
          message: `${browserPkg.relDir} browser source directly imports Node builtin ${builtin}`,
        }), browserPkg, sourceFile, specifier);
        continue;
      }
      if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#')) continue;
      const packageName = workspaceName(specifier);
      const target = byName.get(packageName);
      if (!target) {
        if (declaresWorkspaceDependency(browserPkg, packageName)) {
          recordIssue(finding('unresolved-workspace-import', {
            target: specifier,
            fix: `Register ${packageName} in the kb-devkit workspace package graph, then run kb-devkit check --json.`,
            message: `${browserPkg.json.name} declares ${packageName} as a workspace dependency, but kb-devkit did not register that package`,
          }), browserPkg, sourceFile, specifier);
        }
        continue;
      }
      const subpath = specifier.slice(packageName.length).replace(/^\//, '');
      const resolution = packageEntry(target, subpath);
      if (!resolution.entry) {
        recordIssue(finding(resolution.kind, {
          target: specifier,
          message: resolution.message,
          fix: resolution.kind === 'unbuilt-package-entry'
            ? `Run kb-devkit run build --packages ${target.json.name} to produce its package entry.`
            : `Use a subpath exported by ${target.relDir}/package.json.`,
        }), browserPkg, sourceFile, specifier);
        continue;
      }
      const entry = existingModulePath(resolution.entry);
      if (!entry) {
        recordIssue(finding('unbuilt-package-entry', {
          target: specifier,
          fix: `Run kb-devkit run build --packages ${target.json.name} to produce its package entry.`,
          message: `${target.json.name} has no built output at ${path.relative(workspace, resolution.entry).split(path.sep).join('/')}`,
        }), browserPkg, sourceFile, specifier);
        continue;
      }
      tracedEntries.add(entry);
      for (const issue of traceBuiltGraph(entry, target)) recordIssue(issue, browserPkg, sourceFile, specifier);
      if (target.relDir.startsWith('studio/') && existsSync(path.join(target.absDir, 'src'))) {
        addBrowserSource(target, path.join(target.absDir, 'src'));
      }
    }
  }
  return {
    findings,
    summary: {
      browserPackages: browserPackages.size,
      packageEntriesTraced: tracedEntries.size,
      builtFilesTraced: tracedFiles.size,
    },
  };
}

export function collect(workspaceRoot, workspacePackages) {
  return analyze(workspaceRoot, workspacePackages).findings;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const input = JSON.parse(await readStdin());
  const checkName = input.check ?? 'browser-node-builtins';
  const root = path.resolve(input.workspaceRoot ?? process.cwd());
  const packages = input.workspace?.packages;
  if (typeof input.workspaceRoot !== 'string' || !Array.isArray(packages)) {
    writeCheckResult([{ check: checkName, severity: 'error', message: 'browser Node-builtin check requires workspace package data on stdin', file: root }]);
  } else {
    const issues = collect(root, packages).map((finding) => ({ check: checkName, severity: 'error', ...finding }));
    writeCheckResult(issues);
  }
}
