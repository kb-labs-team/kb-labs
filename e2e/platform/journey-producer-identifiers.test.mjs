import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const platformDirectory = dirname(fileURLToPath(import.meta.url));

test('journey producer scripts resolve every identifier', () => {
  const producerFiles = readdirSync(platformDirectory)
    .filter(filename => filename.endsWith('.mjs'))
    .map(filename => join(platformDirectory, filename));
  const program = ts.createProgram(producerFiles, {
    allowJs: true,
    checkJs: true,
    noEmit: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    types: ['node'],
    skipLibCheck: true,
  });
  const unresolved = ts.getPreEmitDiagnostics(program)
    .filter(diagnostic => [2304, 2503, 2552].includes(diagnostic.code))
    .map(diagnostic => {
      const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
      return `${diagnostic.file.fileName}:${position.line + 1}:${position.character + 1} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`;
    });

  assert.deepEqual(unresolved, [], `Unresolved journey producer identifiers:\n${unresolved.join('\n')}`);
});
