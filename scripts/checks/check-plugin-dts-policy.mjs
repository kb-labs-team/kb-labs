#!/usr/bin/env node
import { writeCheckResult } from './lib/check-result.mjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const input = JSON.parse(await readStdin());
const packageRoot = path.resolve(input.package.Dir);
const packageJsonPath = path.join(packageRoot, 'package.json');
const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
const configPath = path.join(packageRoot, 'tsup.config.ts');
const issues = [];

function issue(message) {
  issues.push({
    check: input.check ?? 'plugin-dts-policy',
    severity: 'error',
    message: `${packageJson.name}: ${message}`,
    file: path.relative(input.workspaceRoot ?? packageRoot, configPath),
  });
}

function nextBuildCommand() {
  return `corepack pnpm --filter ${packageJson.name} build`;
}

try {
  process.chdir(packageRoot);
  const configModule = await import(pathToFileURL(configPath).href);
  const config = configModule.default;
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    issue(
      `tsup config must resolve to an object for plugin DTS policy validation; `
      + `export an object and run ${nextBuildCommand()}.`,
    );
  } else if (typeof config.dts !== 'object' || config.dts === null || config.dts.resolve !== false) {
    issue(
      `tsup config must retain the node preset DTS policy (dts.resolve: false); `
      + `remove plugin-level DTS overrides and run ${nextBuildCommand()}.`,
    );
  }
} catch (error) {
  issue(`cannot resolve tsup config: ${error.message}; correct the config and run ${nextBuildCommand()}.`);
}

writeCheckResult(issues);

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(chunks.join('')));
    process.stdin.on('error', reject);
  });
}
