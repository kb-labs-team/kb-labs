import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandSources } from '../lib/doc-source-map.mjs';
import { renderGeneratedDocSource } from '../lib/expand-doc-sources.mjs';

const docsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(docsDir, '../../../..');

export function sourceFileForCommand(command) {
  return commandSources[command];
}

export function collectGeneratedSources() {
  return Object.fromEntries(Object.entries(commandSources).map(([command, sourcePath]) => {
    const sourceText = readFileSync(path.join(repoRoot, sourcePath), 'utf8');
    return [command, { source: sourcePath, examples: findCommand(sourceText, sourcePath, command) }];
  }));
}

function parseStringArray(sourceText, sourcePath, command) {
  const values = [];
  for (const line of sourceText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;
    const match = trimmed.match(/^(['"])(.*)\1,?$/);
    if (!match) throw new Error(`Command "${command}" examples must be one string literal per line (${sourcePath})`);
    const value = match[2].replace(/\\(['"\\])/g, '$1');
    values.push(value);
  }
  return values;
}

function findCommand(sourceText, sourcePath, command) {
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pathMatch = new RegExp(`\\bpath\\s*:\\s*(['"])${escaped}\\1`).exec(sourceText);
  if (!pathMatch) throw new Error(`Command "${command}" was not found in ${sourcePath}`);
  const start = pathMatch.index + pathMatch[0].length;
  const nextCommand = /\bpath\s*:\s*['"]/.exec(sourceText.slice(start));
  const commandEnd = nextCommand ? start + nextCommand.index : sourceText.length;
  const examplesMatch = /\bexamples\s*:\s*\[/.exec(sourceText.slice(start, commandEnd));
  if (!examplesMatch) throw new Error(`Command "${command}" has no statically readable examples in ${sourcePath}`);
  const arrayStart = start + examplesMatch.index + examplesMatch[0].length;
  let cursor = arrayStart;
  let quote;
  let escapedChar = false;
  while (cursor < commandEnd) {
    const char = sourceText[cursor++];
    if (quote) {
      if (escapedChar) escapedChar = false;
      else if (char === '\\') escapedChar = true;
      else if (char === quote) quote = undefined;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === ']') {
      return parseStringArray(sourceText.slice(arrayStart, cursor - 1), sourcePath, command);
    }
  }
  throw new Error(`Unclosed examples array for "${command}" (${sourcePath})`);
}

export function renderCommandExamples(command, generatedSources, match) {
  const sourcePath = commandSources[command];
  if (!sourcePath) throw new Error(`Command "${command}" is not in the docs source allowlist`);
  const generated = generatedSources?.[command];
  if (generated && generated.source !== sourcePath) {
    throw new Error(`Generated source for "${command}" points to unexpected path ${generated.source}`);
  }
  const sourceData = generated ?? {
    source: sourcePath,
    examples: findCommand(readFileSync(path.join(repoRoot, sourcePath), 'utf8'), sourcePath, command),
  };
  if (sourceData.examples.length === 0) throw new Error(`Command "${command}" has no examples`);
  return renderGeneratedDocSource(command, { [command]: sourceData }, match);
}

export function getDocsDir() {
  return docsDir;
}
