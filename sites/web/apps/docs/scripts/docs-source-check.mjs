import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { writeCheckResult } from '../../../../../scripts/checks/lib/check-result.mjs';

import { syncDocSources } from '../lib/expand-doc-sources.mjs';
import { collectGeneratedSources, getDocsDir } from './docs-source-sync.mjs';

const docsDir = getDocsDir();
const repoRoot = path.resolve(docsDir, '../../../..');
const contentRoot = path.join(docsDir, 'content');
const workflowRunSource = path.join(repoRoot, 'services/workflow/entry/src/commands/workflow-run.ts');
const generatedSourcesPath = path.join(docsDir, 'generated/doc-source-snippets.json');
const failures = [];
const sourceReferences = [];

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(fullPath));
    else if (entry.isFile() && entry.name.endsWith('.mdx')) files.push(fullPath);
  }
  return files;
}

function deprecatedCommandRules() {
  const runText = readFileSync(workflowRunSource, 'utf8');
  const warning = runText.match(/['"](--[\w-]+) is deprecated; use (--[\w-]+) instead['"]/);
  const flagRules = warning ? [{ flag: warning[1], replacement: warning[2] }] : [];
  return { commands: [], flags: flagRules };
}

function main() {
  if (!existsSync(contentRoot)) throw new Error(`Docs content directory not found: ${contentRoot}`);
  const expectedGenerated = `${JSON.stringify(collectGeneratedSources(), null, 2)}\n`;
  if (process.argv.includes('--write')) {
    mkdirSync(path.dirname(generatedSourcesPath), { recursive: true });
    writeFileSync(generatedSourcesPath, expectedGenerated);
    process.stdout.write(`Updated ${path.relative(repoRoot, generatedSourcesPath)}\n`);
    return;
  }
  if (!existsSync(generatedSourcesPath)) {
    failures.push(`Generated docs source file is missing; run "pnpm --filter @kb-labs/docs-site docs:source-sync"`);
  } else if (readFileSync(generatedSourcesPath, 'utf8') !== expectedGenerated) {
    failures.push(`Generated docs sources are stale; run "pnpm --filter @kb-labs/docs-site docs:source-sync" and commit the updated JSON`);
  }
  const generatedSources = JSON.parse(expectedGenerated);
  const mdxFiles = walk(contentRoot);
  const rules = deprecatedCommandRules();

  for (const filePath of mdxFiles) {
    const relativeDoc = path.relative(repoRoot, filePath).split(path.sep).join('/');
    const content = readFileSync(filePath, 'utf8');
    try {
      syncDocSources(content, relativeDoc, generatedSources);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }

    const directivePattern = /<CommandExamples\s+command="([^"]+)"(?:\s+match="([^"]+)")?\s*\/>/g;
    for (const match of content.matchAll(directivePattern)) {
      sourceReferences.push({ doc: relativeDoc, reference: match[1], ...(match[2] ? { exampleMatch: match[2] } : {}) });
    }
    if (content.includes('<NodePolicy />')) {
      sourceReferences.push({ doc: relativeDoc, reference: 'NodePolicy' });
    }

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      for (const rule of rules.commands) {
        if (lines[i].includes(rule.command)) {
          failures.push(`${relativeDoc}:${i + 1} uses deprecated command "${rule.command}"; use "${rule.replacement}"`);
        }
      }
      for (const rule of rules.flags) {
        if (lines[i].includes(rule.flag)) {
          failures.push(`${relativeDoc}:${i + 1} uses deprecated flag "${rule.flag}"; use "${rule.replacement}"`);
        }
      }
    }
  }

  const summary = [
    '### Documentation source sync',
    '',
    `Checked ${mdxFiles.length} MDX files.`,
    sourceReferences.length
      ? `Resolved ${sourceReferences.length} generated source reference(s): ${sourceReferences.map((ref) => `\`${ref.doc}\` → \`${ref.reference}${ref.exampleMatch ? ` (${ref.exampleMatch})` : ''}\``).join(', ')}.`
      : 'No generated source references found.',
    failures.length ? `Found ${failures.length} issue(s).` : 'No stale command examples or broken source references found.',
    '',
  ].join('\n');

  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }
  writeCheckResult(failures.map((message) => ({ check: 'docs-source-check', severity: 'error', message, file: 'sites/web/apps/docs' })));
  process.stdout.write(summary);
  if (failures.length) {
    process.stderr.write(`${failures.map((failure) => `- ${failure}`).join('\n')}\n`);
    process.exitCode = 1;
  }
}

main();
