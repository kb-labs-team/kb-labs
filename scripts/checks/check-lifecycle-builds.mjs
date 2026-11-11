#!/usr/bin/env node
import { writeCheckResult } from './lib/check-result.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function lifecycleTaskIssues(packages, graphTasks, readPackage = (file) => JSON.parse(readFileSync(file, 'utf8'))) {
  const taskNames = new Set(graphTasks);
  const issues = [];
  for (const pkg of packages) {
    const file = path.join(pkg.dir, 'package.json');
    let manifest;
    try {
      manifest = readPackage(file);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      issues.push({ check: 'lifecycle-builds', severity: 'error', message: `cannot read discovered package manifest: ${error.message}`, file });
      continue;
    }
    for (const script of Object.keys(manifest.scripts ?? {})) {
      const task = taskForLifecycle(script, taskNames);
      if (task === undefined) continue;
      issues.push({
        check: 'lifecycle-builds',
        severity: 'error',
        message: `${pkg.name} declares lifecycle script "${script}" for graph task "${task}"; move that work into a kb-devkit task, remove the lifecycle key, then run kb-devkit check --only lifecycle-builds.`,
        file,
      });
    }
  }
  return issues;
}

function taskForLifecycle(script, taskNames) {
  for (const task of taskNames) {
    if (script === `pre${task}` || script === `post${task}`) return task;
  }
  return undefined;
}

async function main() {
  const input = JSON.parse(await readStdin());
  const packages = input.workspace?.packages;
  const graphTasks = input.graphTasks;
  const issues = Array.isArray(packages) && Array.isArray(graphTasks)
    ? lifecycleTaskIssues(packages, graphTasks)
    : [{ check: 'lifecycle-builds', severity: 'error', message: 'kb-devkit did not provide its discovered workspace package set and parsed task graph; rerun kb-devkit check --only lifecycle-builds from the workspace root.', file: '.' }];
  writeCheckResult(issues);
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

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
