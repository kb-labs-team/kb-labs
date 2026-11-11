#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootOption = process.argv.indexOf('--root');
const root = path.resolve(rootOption === -1 ? path.join(scriptDirectory, '../../..') : process.argv[rootOption + 1]);
const check = process.argv.includes('--check');
const catalogPath = path.join(root, 'core/platform/src/error-envelope/errors.catalog.json');
const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
const entries = catalog.codes.filter(({ code }) => code === 'KB_INSTALL_UNSUPPORTED_PLATFORM');
if (entries.length !== 1) throw new Error('error catalog must contain exactly one KB_INSTALL_UNSUPPORTED_PLATFORM entry');
const [entry] = entries;
const templateNames = [...new Set([...entry.message.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map(([, name]) => name))];
if (templateNames.length !== 2 || !templateNames.includes('os') || !templateNames.includes('arch')) {
  throw new Error('unsupported-platform catalog message must declare os and arch template parameters');
}
const message = renderTemplate(entry.message, templateNames);
const hint = `  err "$(printf '%s' ${shellQuote(entry.hint)})"`;
const block = [
  '# BEGIN GENERATED UNSUPPORTED PLATFORM',
  'kb_unsupported_platform() {',
  '  platform_os="$1"',
  '  platform_arch="$2"',
  `  err "$(printf ${shellQuote(`${entry.code}: ${message.format}`)} ${message.arguments.join(' ')})"`,
  hint,
  '  exit 1',
  '}',
  '# END GENERATED UNSUPPORTED PLATFORM',
].join('\n');
const installers = [
  'tools/kb-create/install.sh',
  'tools/kb-dev/install.sh',
  'tools/kb-deploy/install.sh',
  'tools/kb-devkit/install.sh',
  'tools/kb-monitor/install.sh',
];
let failed = false;
for (const relativePath of installers) {
  const target = path.join(root, relativePath);
  const source = readFileSync(target, 'utf8');
  const generated = replaceBlock(source, block);
  if (generated === undefined) {
    process.stderr.write(`${relativePath} must contain exactly one generated unsupported-platform marker pair\n`);
    failed = true;
    continue;
  }
  if (generated === source) continue;
  if (check) {
    process.stderr.write(`${relativePath} is stale; run node tools/kb-create/scripts/generate-unsupported-platform.mjs\n`);
    failed = true;
  } else {
    writeFileSync(target, generated, 'utf8');
  }
}
if (failed) process.exitCode = 1;

function renderTemplate(template, names) {
  const argumentsList = [];
  const format = template.replace(/%/g, '%%').replace(/\{([A-Za-z0-9_]+)\}/g, (_match, name) => {
    if (!names.includes(name)) throw new Error(`unsupported-platform message declares unexpected parameter ${name}`);
    argumentsList.push(`"$platform_${name}"`);
    return '%s';
  });
  return { format, arguments: argumentsList };
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function replaceBlock(source, block) {
  const lines = source.split(/\r?\n/);
  const startMarker = '# BEGIN GENERATED UNSUPPORTED PLATFORM';
  const endMarker = '# END GENERATED UNSUPPORTED PLATFORM';
  const starts = lines.flatMap((line, index) => line === startMarker ? [index] : []);
  const ends = lines.flatMap((line, index) => line === endMarker ? [index] : []);
  if (starts.length !== 1 || ends.length !== 1 || starts[0] >= ends[0]) return undefined;
  const original = lines.slice(starts[0], ends[0] + 1).join('\n');
  if (original === block) return source;
  lines.splice(starts[0], ends[0] - starts[0] + 1, ...block.split('\n'));
  return lines.join('\n');
}
