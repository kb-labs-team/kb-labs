import assert from 'node:assert/strict';
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

test('expands the MDX directive from the generated snapshot', () => {
  const rendered = syncDocSources('<CommandExamples command="workflow runs status" />', 'test.mdx', generatedSources);
  assert.match(rendered, /kb workflow runs status --run-id=<runId>/);
  assert.doesNotMatch(rendered, /<CommandExamples/);
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
