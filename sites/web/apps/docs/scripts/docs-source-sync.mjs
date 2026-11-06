import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { commandSources, sourceFragmentSources } from '../lib/doc-source-map.mjs';
import { renderGeneratedDocSource } from '../lib/expand-doc-sources.mjs';
import { parseNodeEnginePolicy } from '@kb-labs/plugin-contracts/node-engine-policy';

const docsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(docsDir, '../../../..');

export function collectGeneratedSources() {
  const generated = Object.fromEntries(Object.entries(commandSources).map(([command, source]) => {
    const sourceText = readFileSync(path.join(repoRoot, source.source), 'utf8');
    return [command, { source: source.source, examples: findCommand(sourceText, source.source, command) }];
  }));
  const nodePolicySource = sourceFragmentSources.nodePolicy;
  const rootManifest = JSON.parse(readFileSync(path.join(repoRoot, nodePolicySource), 'utf8'));
  const { requiredMajor } = parseNodeEnginePolicy(rootManifest.engines?.node);
  return {
    commands: generated,
    nodePolicy: { source: nodePolicySource, requiredMajor },
  };
}

function objectProperty(object, name, sourcePath) {
  if (ts.isSatisfiesExpression(object) || ts.isAsExpression(object)) object = object.expression;
  if (!ts.isObjectLiteralExpression(object)) throw new Error(`Expected an object in ${sourcePath}`);
  const property = object.properties.find((item) =>
    ts.isPropertyAssignment(item) && (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) && item.name.text === name);
  if (!property || !ts.isPropertyAssignment(property)) throw new Error(`Property "${name}" was not found in ${sourcePath}`);
  return property.initializer;
}

function findCommand(sourceText, sourcePath, command) {
  const source = ts.createSourceFile(sourcePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declarations = source.statements.flatMap((statement) =>
    ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : []);
  const registry = declarations.find((declaration) =>
    ts.isIdentifier(declaration.name) && declaration.name.text === 'workflowServiceCommands');
  if (!registry?.initializer) throw new Error(`Workflow command registry was not found in ${sourcePath}`);
  const commands = objectProperty(registry.initializer, 'commands', sourcePath);
  const commandObject = ts.isSatisfiesExpression(commands) ? commands.expression : commands;
  if (!ts.isObjectLiteralExpression(commandObject)) throw new Error(`Expected command declarations in ${sourcePath}`);
  const declaration = commandObject.properties
    .filter(ts.isPropertyAssignment)
    .map((property) => property.initializer)
    .find((initializer) => {
      const name = objectProperty(initializer, 'name', sourcePath);
      return ts.isStringLiteral(name) && name.text === command;
    });
  if (!declaration) throw new Error(`Command "${command}" was not found in ${sourcePath}`);
  const examples = objectProperty(declaration, 'examples', sourcePath);
  if (!ts.isArrayLiteralExpression(examples) || !examples.elements.every(ts.isStringLiteral)) {
    throw new Error(`Command "${command}" examples must be string literals in ${sourcePath}`);
  }
  return examples.elements.map((example) => example.text);
}

export function renderCommandExamples(command, generatedSources, match) {
  const sourcePath = commandSources[command]?.source;
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
