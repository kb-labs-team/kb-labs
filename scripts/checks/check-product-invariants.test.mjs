import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { productInvariantIssues } from './check-product-invariants.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const validDocument = await readFile(path.join(repositoryRoot, 'docs/product/invariants.md'), 'utf8');

function section(markdown, id) {
  const headings = [...markdown.matchAll(/^## (INV-\d{2}) — .+$/gm)];
  const index = headings.findIndex((heading) => heading[1] === id);
  if (index < 0) throw new Error(`missing fixture section ${id}`);
  const start = headings[index].index;
  const end = headings[index + 1]?.index ?? markdown.length;
  return markdown.slice(start, end);
}

function replaceSection(markdown, id, update) {
  const original = section(markdown, id);
  return markdown.replace(original, update(original));
}

async function expectRejected(markdown, pattern) {
  const issues = productInvariantIssues(markdown, repositoryRoot);
  assert.notDeepEqual(issues, []);
  if (pattern) assert.ok(issues.some(({ message }) => pattern.test(message)), JSON.stringify(issues));
  return issues;
}

test('product invariants document passes the structural and path check', async () => {
  assert.deepEqual(productInvariantIssues(validDocument, repositoryRoot), []);
});

test('rejects a missing invariant id', async () => {
  await expectRejected(validDocument.replace(section(validDocument, 'INV-03'), ''), /missing.*INV-03/i);
});

test('rejects a duplicate invariant id', async () => {
  await expectRejected(`${validDocument}\n${section(validDocument, 'INV-01')}`, /duplicate.*INV-01/i);
});

test('rejects an extra invariant id', async () => {
  await expectRejected(`${validDocument}\n${section(validDocument, 'INV-01').replace('INV-01', 'INV-13')}`, /unexpected.*INV-13/i);
});

test('rejects an unknown status', async () => {
  await expectRejected(validDocument.replace('**Status:** enforced', '**Status:** someday'), /unknown status/i);
});

test('rejects missing Rule and Why fields', async () => {
  const malformed = replaceSection(validDocument, 'INV-01', (value) => value.replace(/^\*\*Rule:\*\*.*\n\n|^\*\*Why:\*\*.*\n\n/gm, ''));
  const issues = await expectRejected(malformed);
  assert.ok(issues.some(({ message }) => /requires exactly one non-empty Rule/.test(message)));
  assert.ok(issues.some(({ message }) => /requires exactly one non-empty Why/.test(message)));
});

test('rejects a partial entry without a Gap', async () => {
  await expectRejected(replaceSection(validDocument, 'INV-06', (value) => value.replace('**Status:** enforced', '**Status:** partial')), /Gap/i);
});

test('rejects an empty Gap', async () => {
  await expectRejected(replaceSection(validDocument, 'INV-06', (value) => value.replace('**Status:** enforced', '**Gap:**   \n\n**Status:** partial')), /Gap/i);
});

test('rejects a debt entry without a Gap and owner', async () => {
  const issues = await expectRejected(replaceSection(validDocument, 'INV-06', (value) => value.replace('**Status:** enforced', '**Status:** debt')));
  assert.ok(issues.some(({ message }) => /debt status requires a non-empty Gap/i.test(message)));
  assert.ok(issues.some(({ message }) => /debt status requires exactly one non-empty Owner/i.test(message)));
});

test('rejects a partial Gap without a concrete linked owner', async () => {
  const malformed = replaceSection(validDocument, 'INV-06', (value) => value.replace('**Status:** enforced', '**Gap:** Add the missing rail.\n\n**Status:** partial'));
  await expectRejected(malformed, /Owner repository path/i);
});

test('rejects a Gap owner path that does not exist', async () => {
  const malformed = replaceSection(validDocument, 'INV-06', (value) => value.replace('**Status:** enforced', '**Gap:** Add the missing rail.\n\n**Owner:** [checks](../../scripts/checks/missing.mjs)\n\n**Status:** partial'));
  await expectRejected(malformed, /Owner path does not exist/i);
});

test('rejects an external-only enforcement link', async () => {
  const malformed = replaceSection(validDocument, 'INV-01', (value) => value.replace(/^\*\*Enforcement:\*\*.*$/m, '**Enforcement:** [external](https://example.com/check)'));
  await expectRejected(malformed, /repository-relative path/i);
});

test('rejects an empty enforcement link', async () => {
  const malformed = replaceSection(validDocument, 'INV-01', (value) => value.replace(/^\*\*Enforcement:\*\*.*$/m, '**Enforcement:** [empty]()'));
  await expectRejected(malformed, /repository-relative path/i);
});

test('rejects an enforcement path outside the repository', async () => {
  const malformed = replaceSection(validDocument, 'INV-01', (value) => value.replace(/^\*\*Enforcement:\*\*.*$/m, '**Enforcement:** [outside](../../../../outside.mjs)'));
  await expectRejected(malformed, /outside.*repository/i);
});

test('rejects a missing enforcement target', async () => {
  const malformed = replaceSection(validDocument, 'INV-01', (value) => value.replace(/^\*\*Enforcement:\*\*.*$/m, '**Enforcement:** [missing](../../scripts/checks/missing.mjs)'));
  await expectRejected(malformed, /does not exist/i);
});

test('rejects external and empty targets even when another enforcement link is valid', async () => {
  const markdown = replaceSection(validDocument, 'INV-01', (value) => value.replace(/^\*\*Enforcement:\*\*.*$/m, '**Enforcement:** [valid](../../scripts/checks/check-release-build-graph.mjs) [external](https://example.com) [empty]()'));
  await expectRejected(markdown, /external|empty|repository-relative path/i);
});
