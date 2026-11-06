import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { syncDocSources } from '../lib/expand-doc-sources.mjs';
import { collectGeneratedSources, getDocsDir, renderCommandExamples } from './docs-source-sync.mjs';

const generatedSources = collectGeneratedSources();

test('generated command examples match the committed source snapshot', () => {
  const snapshotPath = path.join(getDocsDir(), 'generated/doc-source-snippets.json');
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  assert.deepEqual(snapshot, generatedSources);
});

test('generated Node policy matches the root package engine declaration', () => {
  const snapshotPath = path.join(getDocsDir(), 'generated/doc-source-snippets.json');
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  assert.deepEqual(snapshot, generatedSources);
  assert.equal(generatedSources.nodePolicy.source, 'package.json');
  assert.ok(Number.isSafeInteger(generatedSources.nodePolicy.requiredMajor));
});

test('expands the allowlisted Node policy fragment from its generated snapshot', () => {
  const rendered = syncDocSources('<NodePolicy />', 'test.mdx', generatedSources);
  assert.equal(rendered, String(generatedSources.nodePolicy.requiredMajor));
  assert.equal(
    syncDocSources('FROM node:<NodePolicy />-slim', 'test.mdx', generatedSources),
    `FROM node:${generatedSources.nodePolicy.requiredMajor}-slim`,
  );
});

test('the kb-devkit Docker example renders both image stages from the Node policy source', () => {
  const pagePath = path.join(getDocsDir(), 'content/en/services/kb-devkit.mdx');
  const page = readFileSync(pagePath, 'utf8');
  const rendered = syncDocSources(page, 'content/en/services/kb-devkit.mdx', generatedSources);
  const major = generatedSources.nodePolicy.requiredMajor;

  assert.equal((page.match(/FROM node:<NodePolicy \/>-alpine AS/g) ?? []).length, 2);
  assert.equal((rendered.match(new RegExp(`FROM node:${major}-alpine AS`, 'g')) ?? []).length, 2);
  assert.doesNotMatch(rendered, /<NodePolicy \/>/);
});

test('rejects a Node policy snapshot that points outside its allowlisted source', () => {
  assert.throws(
    () => syncDocSources('<NodePolicy />', 'test.mdx', {
      ...generatedSources,
      nodePolicy: { ...generatedSources.nodePolicy, source: '../../outside.json' },
    }),
    /unexpected path/,
  );
});

test('renders allowlisted command examples as a fenced shell block', () => {
  const rendered = renderCommandExamples('workflow runs status', generatedSources.commands);
  assert.match(rendered, /^```bash title="Generated from services\/workflow\/contracts\/src\/service-commands\.ts"/);
  assert.match(rendered, /kb workflow runs status <runId>/);
});

test('keeps JSON CLI examples intact when extracting escaped manifest strings', () => {
  const rendered = renderCommandExamples('workflow run', generatedSources.commands, '--input');
  assert.ok(rendered.includes(`--input='{"key":"value"}'`));
  assert.equal(rendered.includes('release-manager/create-release'), false);
});

test('expands the MDX directive from the generated snapshot', () => {
  const rendered = syncDocSources('<CommandExamples command="workflow runs status" />', 'test.mdx', generatedSources);
  assert.match(rendered, /kb workflow runs status --run-id=<runId>/);
  assert.doesNotMatch(rendered, /<CommandExamples/);
});

test('rejects an example filter that no longer matches the source', () => {
  assert.throws(
    () => syncDocSources('<CommandExamples command="workflow run" match="--missing" />', 'test.mdx', generatedSources),
    /No examples.*match/,
  );
});

test('rejects commands outside the explicit source allowlist', () => {
  assert.throws(
    () => syncDocSources('<CommandExamples command="workflow run arbitrary" />', 'test.mdx', generatedSources),
    /not in the docs source allowlist/,
  );
});

test('rejects generated snapshots that point outside the allowlisted source', () => {
  assert.throws(
    () => renderCommandExamples('workflow runs status', {
      'workflow runs status': { source: '../../outside.ts', examples: ['echo unsafe'] },
    }),
    /unexpected path/,
  );
});

test('an explicit generated source reference takes precedence over broad owner zones', () => {
  const output = execFileSync(process.execPath, ['scripts/docs-staleness.mjs'], {
    cwd: getDocsDir(),
    input: 'services/workflow/contracts/src/service-commands.ts',
    encoding: 'utf8',
  });
  const { affected } = JSON.parse(output);

  assert.deepEqual(affected.map((page) => page.slug), ['guides/first-workflow']);
  assert.equal(affected[0].matchKind, 'exact');
  assert.deepEqual(affected[0].sourceReferences, ['workflow runs list', 'workflow runs logs']);
});

test('the root engine declaration marks only NodePolicy pages as exact source references', () => {
  const output = execFileSync(process.execPath, ['scripts/docs-staleness.mjs'], {
    cwd: getDocsDir(),
    input: 'package.json',
    encoding: 'utf8',
  });
  const { affected } = JSON.parse(output);

  assert.ok(affected.some((page) => page.slug === 'installation'));
  assert.ok(affected.some((page) => page.slug === 'sdk/plugin-api/index'));
  assert.ok(affected.some((page) => page.slug === 'operations/self-hosted-cloud'));
  assert.ok(affected.every((page) => page.matchKind === 'exact'));
  assert.ok(affected.every((page) => page.sourceReferences.includes('NodePolicy')));
});

test('workflow engine ownership zones point at real, relevant source areas', () => {
  const output = execFileSync(process.execPath, ['scripts/docs-staleness.mjs'], {
    cwd: getDocsDir(),
    input: 'services/workflow/engine/src/retry.ts',
    encoding: 'utf8',
  });
  const { affected } = JSON.parse(output);

  assert.deepEqual(
    affected.map((page) => page.slug).sort(),
    ['concepts/workflow-engine', 'guides/first-workflow', 'workflows/jobs', 'workflows/retry-and-errors'],
  );
  assert.ok(affected.every((page) => page.matchKind === 'zone'));
});

test('documentation edits do not self-trigger the docs landing page', () => {
  const output = execFileSync(process.execPath, ['scripts/docs-staleness.mjs'], {
    cwd: getDocsDir(),
    input: [
        'sites/web/apps/docs/CONVENTIONS.md',
        'sites/web/apps/docs/sitemap.config.json',
      ].join('\n'),
    encoding: 'utf8',
  });
  const { affected } = JSON.parse(output);

  assert.equal(affected.some((page) => page.slug === 'index'), false);
});
