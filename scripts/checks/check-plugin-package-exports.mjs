#!/usr/bin/env node
import { writeCheckResult } from './lib/check-result.mjs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const input = JSON.parse(await readStdin());
const checkName = input.check;
const packageRoot = input.package.Dir;
const packageJsonPath = path.join(packageRoot, 'package.json');
const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
const issues = [];

function issue(target, message) {
  issues.push({
    check: checkName,
    severity: 'error',
    message: `${packageJson.name}: ${target}: ${message}`,
    file: `${path.relative(input.workspaceRoot ?? packageRoot, packageJsonPath)}`,
  });
}

function targets(value, targetPath, output = []) {
  if (typeof value === 'string') {
    output.push({ value, targetPath });
  } else if (Array.isArray(value)) {
    value.forEach((entry, index) => targets(entry, `${targetPath}[${index}]`, output));
  } else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      targets(entry, `${targetPath}.${key}`, output);
    }
  }
  return output;
}

const exportMap = packageJson.exports;
if (!exportMap || typeof exportMap !== 'object' || Array.isArray(exportMap)) {
  issue('package.json#exports', 'must declare an exports object');
} else {
  for (const [subpath, value] of Object.entries(exportMap)) {
    if (subpath.includes('*')) {
      issue(`package.json#exports.${subpath}`, `wildcard export ${subpath} is not allowed; declare explicit subpaths`);
    }
    for (const { value: target, targetPath } of targets(value, `package.json#exports.${subpath}`)) {
      if (target.includes('*')) {
        issue(targetPath, `wildcard target ${target} is not allowed; declare explicit targets`);
        continue;
      }
      if (!target.startsWith('./')) {
        issue(targetPath, `export target ${target} must be package-relative`);
        continue;
      }
      const resolved = path.resolve(packageRoot, target);
      const relativeToPackage = path.relative(packageRoot, resolved);
      if (relativeToPackage === '..' || relativeToPackage.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToPackage)) {
        issue(targetPath, `export target ${target} is outside the package build output`);
        continue;
      }
      try {
        await stat(resolved);
      } catch {
        issue(targetPath, `export target ${target} does not exist in the package build output`);
      }
    }
  }
}

writeCheckResult(issues);

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => chunks.push(chunk));
    process.stdin.on('end', () => resolve(chunks.join('')));
    process.stdin.on('error', reject);
  });
}
