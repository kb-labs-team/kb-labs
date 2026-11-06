#!/usr/bin/env node
import { writeCheckResult } from './lib/check-result.mjs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseNodeEnginePolicy, readNodeEngineDeclaration } from '@kb-labs/plugin-contracts/node-engine-policy';
import { nodeImageIssues } from './node-engine-dockerfiles.mjs';
import { inspectPrebuildImportGraph, nodeEnginePrebuildEntry } from './prebuild-imports.mjs';
import { checkAuthoredEsmDeclarationDrift } from './authored-esm-declarations.mjs';

const inputText = await readStdin();
if (inputText.trim() === '') {
  console.error('node-engine-policy requires workspace input on stdin; next: kb-devkit check --only node-engine-policy --json');
  process.exit(2);
}
const input = JSON.parse(inputText);
const check = input.check ?? 'node-engine-policy';
const issues = [];
const workspaceRoot = typeof input.workspaceRoot === 'string' ? path.resolve(input.workspaceRoot) : undefined;
const packages = input.workspace?.packages;
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

for (const item of inspectPrebuildImportGraph(
  nodeEnginePrebuildEntry(repositoryRoot),
  repositoryRoot,
)) {
  issue(item.file, item.resolved
    ? `pre-build import ${JSON.stringify(item.specifier)} resolves to ${item.resolved}; pre-build modules must not depend on build output or modules outside the workspace`
    : `pre-build import ${JSON.stringify(item.specifier)} cannot be resolved`);
}

if (Array.isArray(packages)) {
  for (const item of checkAuthoredEsmDeclarationDrift(packages, repositoryRoot)) {
    issue(item.file, item.message);
  }
}

function issue(file, message) {
  issues.push({ check, severity: 'error', message, file });
}

let rootPolicy;
if (workspaceRoot === undefined) {
  issue('.', 'workspace root input is missing; run this check through kb-devkit');
} else {
  const rootManifest = path.join(workspaceRoot, 'package.json');
  try {
    const declaration = readNodeEngineDeclaration(rootManifest);
    if (declaration === undefined) throw new Error('root package.json must declare engines.node');
    parseNodeEnginePolicy(declaration);
    rootPolicy = declaration;
  } catch (error) {
    issue(rootManifest, error.message);
  }
}

if (workspaceRoot !== undefined && rootPolicy !== undefined) {
  const { requiredMajor } = parseNodeEnginePolicy(rootPolicy);
  try {
    for (const item of nodeImageIssues(workspaceRoot, requiredMajor, {
      includeJourneyRunnerContract: workspaceRoot === repositoryRoot,
    })) {
      issue(item.file, item.message);
    }
  } catch (error) {
    issue('e2e/journey/Dockerfile.runner', `cannot verify the runner toolchain image contract: ${error.message}`);
  }
}

if (!Array.isArray(packages)) {
  issue(workspaceRoot ?? '.', 'workspace package registry is missing; run this check through kb-devkit');
} else {
  for (const pkg of packages) {
    const manifest = path.resolve(pkg.dir, 'package.json');
    if (!existsSync(manifest)) continue;
    try {
      const packagePolicy = readNodeEngineDeclaration(manifest);
      if (packagePolicy !== undefined && rootPolicy !== undefined && packagePolicy !== rootPolicy) {
        issue(manifest,
          `package ${pkg.name} declares engines.node ${JSON.stringify(packagePolicy)}, but root package.json declares ${JSON.stringify(rootPolicy)}`);
      }
    } catch (error) {
      issue(manifest, `package ${pkg.name}: ${error.message}`);
    }
  }
}

if (rootPolicy !== undefined) {
  const generator = path.join(repositoryRoot, 'tools/clikit/toolchain/generate-node-policy.mjs');
  const generated = spawnSync(process.execPath, [generator, '--check', '--root', workspaceRoot], {
    encoding: 'utf8',
  });
  if (generated.status !== 0) {
    issue(path.join(workspaceRoot, 'tools/clikit/toolchain/node_policy_gen.go'),
      generated.stderr.trim() || `generated Go Node policy check exited ${generated.status}`);
  }

  if (workspaceRoot === repositoryRoot) {
    const compiled = spawnSync('go', ['test', './toolchain'], {
      cwd: path.join(repositoryRoot, 'tools/clikit'),
      encoding: 'utf8',
    });
    if (compiled.status !== 0) {
      issue(path.join(repositoryRoot, 'tools/clikit/toolchain'),
        compiled.stderr.trim() || compiled.stdout.trim() || `Go Node policy compile check exited ${compiled.status}`);
    }
  }
}

  writeCheckResult(issues);
for (const finding of issues) {
  process.stderr.write(`${finding.check}: ${finding.file}: ${finding.message}\n`);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(chunks.join('')));
    process.stdin.on('error', reject);
  });
}
