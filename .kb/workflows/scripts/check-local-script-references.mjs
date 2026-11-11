#!/usr/bin/env node
// Ensure workspace workflows cannot reference a local script that is absent from git.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeCheckResult } from '../../../scripts/checks/lib/check-result.mjs';

const root = process.cwd();
const workflowsDir = join(root, '.kb', 'workflows');
const workflowFiles = readdirSync(workflowsDir)
  .filter((name) => /\.ya?ml$/i.test(name))
  .map((name) => join(workflowsDir, name));
const missing = [];

for (const workflowFile of workflowFiles) {
  const source = readFileSync(workflowFile, 'utf8');
  for (const match of source.matchAll(/\bnode\s+(\.kb\/workflows\/scripts\/[A-Za-z0-9._-]+\.mjs)\b/g)) {
    const script = match[1];
    if (!existsSync(join(root, script))) {
      missing.push(`${workflowFile.replace(`${root}/`, '')}: ${script}`);
    }
  }
}

if (missing.length > 0) {
  console.error('Workflow local-script references are missing:');
  for (const item of missing) console.error(`  - ${item}`);
  writeCheckResult(missing.map((message) => ({ check: 'local-workflow-script-references', severity: 'error', message })));
  process.exit(1);
}

writeCheckResult([]);
console.log(`Workflow local-script references verified (${workflowFiles.length} workflow files).`);
