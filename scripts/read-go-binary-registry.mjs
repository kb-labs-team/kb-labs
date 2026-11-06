#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';

export function readGoBinaryRegistry(configPath = new URL('../devkit.yaml', import.meta.url)) {
  const config = load(readFileSync(configPath, 'utf8'));
  const categories = Object.values(config?.workspace?.categories ?? {})
    .filter((category) => category?.language === 'go' && category?.releaseLane !== 'internal-tool');
  const registry = categories.flatMap((category) => category.match ?? []);
  if (categories.length === 0 || registry.length === 0 || registry.some((pattern) => typeof pattern !== 'string' || !pattern)) {
    throw new Error('devkit Go package categories must contain non-empty match arrays');
  }
  return [...new Set(registry)];
}

const configFlag = process.argv.indexOf('--config');
const configPath = configFlag >= 0 ? process.argv[configFlag + 1] : undefined;
if (configFlag >= 0 && !configPath) throw new Error('--config requires a path');
const registry = readGoBinaryRegistry(configPath);
process.stdout.write(`${JSON.stringify(registry)}\n`);
