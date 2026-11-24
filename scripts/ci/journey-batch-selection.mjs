#!/usr/bin/env node
// Single owner of the journey batch case selection (S-262.8).
//
// Every trigger of .github/workflows/journey-batch.yml maps to one declared
// selection. `full` is the gating batch (S-262.8: "A full run without a
// selection remains the only gating batch") and is requested by omitting
// --cases; `cases` is a partial batch named by the pushed ref. An event with no
// declared selection is an error, never an implicit full or empty run.
//
//   resolve <event> <ref>        -> prints `selection=full|cases:<b64>` (GITHUB_OUTPUT line)
//   run <selection> -- <cmd...>  -> runs cmd with `--cases <ids>` appended for a `cases:` selection
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CASES_REF = /^batch\/.+\/cases\/(?<encoded>.+)$/;
const AREA_REF = /^batch\/.+\/areas\/(?<area>.*)$/;

function decodeCases(encoded) {
  return Buffer.from(encoded.replace(/_/g, '/').replace(/-/g, '+'), 'base64').toString('utf8');
}

// Producer-side events of the workflow, each with its declared selection kind.
export const TRIGGER_SELECTIONS = {
  push: ({ ref }) => {
    const match = CASES_REF.exec(ref);
    if (match) return `cases:${match.groups.encoded}`;
    const area = AREA_REF.exec(ref);
    if (area) {
      if (!/^[a-z][a-z0-9-]*$/.test(area.groups.area)) {
        throw new Error(`journey batch ref "${ref}" has an invalid or empty product area; use a lowercase QA area slug`);
      }
      return `area:${area.groups.area}`;
    }
    return 'full';
  },
  pull_request: () => 'full',
  workflow_dispatch: () => 'full',
};

export function resolveSelection(event, ref) {
  const select = TRIGGER_SELECTIONS[event];
  if (!select) {
    throw new Error(
      `journey batch has no declared case selection for trigger "${event}"; declare it in TRIGGER_SELECTIONS (scripts/ci/journey-batch-selection.mjs)`,
    );
  }
  const selection = select({ ref });
  if (selection.startsWith('cases:') && decodeCases(selection.slice(6)).trim() === '') {
    throw new Error(`journey batch ref "${ref}" encodes an empty case selection; name at least one case or step ID`);
  }
  return selection;
}

export function batchArguments(selection) {
  if (selection === 'full') return [];
  if (selection.startsWith('cases:')) return ['--cases', decodeCases(selection.slice(6))];
  if (selection.startsWith('area:') && /^[a-z][a-z0-9-]*$/.test(selection.slice(5))) {
    return ['--area', selection.slice(5)];
  }
  throw new Error(`unknown journey batch selection "${selection}"; expected "full" or "cases:<encoded ids>"`);
}

export function sharedUnitSuiteMode(selection) {
  if (selection === 'full') return 'run';
  if (selection.startsWith('cases:') && decodeCases(selection.slice(6)).trim() !== '') return 'skip';
  if (selection.startsWith('area:') && /^[a-z][a-z0-9-]*$/.test(selection.slice(5))) return 'skip';
  throw new Error(`unknown journey batch selection "${selection}"; expected "full" or "cases:<encoded ids>"`);
}

export function selectionIds(selection) {
  if (selection === 'full') return '';
  if (selection.startsWith('cases:')) {
    const ids = decodeCases(selection.slice(6)).trim();
    if (ids) return ids;
  }
  if (selection.startsWith('area:') && /^[a-z][a-z0-9-]*$/.test(selection.slice(5))) {
    return `@area:${selection.slice(5)}`;
  }
  throw new Error(`unknown journey batch selection "${selection}"; expected "full" or "cases:<encoded ids>"`);
}

function main(argv) {
  const [command, ...rest] = argv;
  if (command === 'resolve' && rest.length === 2) {
    process.stdout.write(`selection=${resolveSelection(rest[0], rest[1])}\n`);
    return 0;
  }
  if (command === 'run' && rest[1] === '--' && rest.length > 2) {
    const [selection, , executable, ...args] = rest;
    const result = spawnSync(executable, [...args, ...batchArguments(selection)], { stdio: 'inherit' });
    return result.status ?? 1;
  }
  if (command === 'shared-unit-suite' && rest.length === 1) {
    process.stdout.write(`${sharedUnitSuiteMode(rest[0])}\n`);
    return 0;
  }
  if (command === 'ids' && rest.length === 1) {
    process.stdout.write(`${selectionIds(rest[0])}\n`);
    return 0;
  }
  process.stderr.write('usage: journey-batch-selection.mjs resolve <event> <ref> | run <selection> -- <command...> | shared-unit-suite <selection> | ids <selection>\n');
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
}
