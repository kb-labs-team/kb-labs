#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const page = 'sites/web/apps/docs/content/en/guides/release-journey-coverage.mdx';
const startMarker = '<!-- generated-case-coverage:start -->';
const endMarker = '<!-- generated-case-coverage:end -->';

function coverage(mode) {
  const output = execFileSync('node', ['./cli/bin/dist/bin.js', 'qa', 'coverage', 'show', '--level', 'all', '--mode', mode, '--json'], { encoding: 'utf8' });
  const envelope = JSON.parse(output);
  if (envelope.ok !== true) throw new Error(`QA coverage command failed for ${mode}`);
  const result = envelope.data;
  if (result.schema !== 'kb.qa-case-coverage/v1') throw new Error(`Unexpected coverage schema for ${mode}`);
  return result;
}

function render(result) {
  const rows = result.cases.filter(item => item.statusResult !== 'NOT REQUIRED').map(item => {
    const steps = item.steps.map(step => `${step.stepId}: ${step.status}`).join('<br />');
    return `| ${item.id} — ${item.title.replaceAll('|', '\\|')} | ${steps || '—'} | ${item.statusResult} |`;
  });
  return [`### ${result.mode} mode`, '', '| Case | Step coverage | Case result |', '| --- | --- | --- |', ...rows].join('\n');
}

const generated = [render(coverage('local')), render(coverage('secured'))].join('\n\n');
const source = readFileSync(page, 'utf8');
const begin = source.indexOf(startMarker);
const end = source.indexOf(endMarker);
if (begin < 0 || end < begin) throw new Error(`Coverage markers are missing from ${page}`);
writeFileSync(page, `${source.slice(0, begin + startMarker.length)}\n\n${generated}\n\n${source.slice(end)}`);
