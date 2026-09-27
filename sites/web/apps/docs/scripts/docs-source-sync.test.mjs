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

test('renders allowlisted command examples as a fenced shell block', () => {
  const rendered = renderCommandExamples('workflow runs status', generatedSources);
  assert.match(rendered, /^```bash title="Generated from plugins\/workflow\/entry\/src\/manifest\.ts"/);
  assert.match(rendered, /kb workflow runs status <runId>/);
});

test('keeps JSON CLI examples intact when extracting escaped manifest strings', () => {
  const rendered = renderCommandExamples('workflow run', generatedSources, '--input');
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
    env: { ...process.env, CHANGED_FILES: 'plugins/workflow/entry/src/manifest.ts' },
    encoding: 'utf8',
  });
  const { affected } = JSON.parse(output);

  assert.deepEqual(affected.map((page) => page.slug), ['guides/first-workflow']);
  assert.equal(affected[0].matchKind, 'exact');
  assert.deepEqual(affected[0].sourceReferences, ['workflow run', 'workflow runs status']);
});

test('workflow engine ownership zones point at real, relevant source areas', () => {
  const output = execFileSync(process.execPath, ['scripts/docs-staleness.mjs'], {
    cwd: getDocsDir(),
    env: { ...process.env, CHANGED_FILES: 'plugins/workflow/engine/src/retry.ts' },
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
    env: {
      ...process.env,
      CHANGED_FILES: [
        'sites/web/apps/docs/CONVENTIONS.md',
        'sites/web/apps/docs/sitemap.config.json',
      ].join('\n'),
    },
    encoding: 'utf8',
  });
  const { affected } = JSON.parse(output);

  assert.equal(affected.some((page) => page.slug === 'index'), false);
});
