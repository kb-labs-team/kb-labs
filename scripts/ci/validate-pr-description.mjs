#!/usr/bin/env node
import { writeCheckResult } from '../checks/lib/check-result.mjs';
/**
 * Validate a PR title and body against the structure in
 * .github/PULL_REQUEST_TEMPLATE.md. Reads the pull_request event payload
 * (GITHUB_EVENT_PATH) and exits 1 with a human-readable list of problems.
 */

import fs from 'node:fs';

const ALLOWED_TYPES = ['feat', 'fix', 'chore', 'refactor', 'perf', 'test', 'docs'];

// Titles that pass the type/scope regex but carry no real information.
const GENERIC_MESSAGES = new Set([
  'wip', 'fix', 'fixes', 'fixed', 'update', 'updates', 'updated',
  'change', 'changes', 'changed', 'test', 'stuff', 'misc', 'cleanup',
  'fix bug', 'bug fix', 'minor fix', 'small fix', 'various fixes',
]);

const REQUIRED_SECTIONS = ['What', 'Why', 'How verified', 'Plan / Reference', 'Checklist'];
// Sections whose content must say something beyond the template placeholder.
const CONTENT_SECTIONS = ['What', 'Why', 'How verified'];
const MIN_SECTION_LENGTH = 10;

const TITLE_RE = new RegExp(`^(${ALLOWED_TYPES.join('|')})(\\([a-z0-9][a-z0-9._-]*\\))?!?: (.+)$`);
const TASK_TAG_RE = /\s*\[[A-Za-z0-9_-]+\]\s*$/;

export function validateTitle(title) {
  const errors = [];
  const trimmed = (title ?? '').trim();
  const match = TITLE_RE.exec(trimmed);
  if (!match) {
    errors.push(
      `Title must look like "<type>(<scope>): <message>" (types: ${ALLOWED_TYPES.join(', ')}). Got: "${trimmed}"`,
    );
    return errors;
  }
  const message = match[3].replace(TASK_TAG_RE, '').trim();
  if (message.length < 8 || GENERIC_MESSAGES.has(message.toLowerCase())) {
    errors.push(
      `Title message "${message}" is too generic — describe what the PR actually does, not just its type.`,
    );
  }
  return errors;
}

function sectionBodies(body) {
  const text = body ?? '';
  const headingRe = /^##\s+(.+?)\s*$/gm;
  const headings = [...text.matchAll(headingRe)];
  const sections = new Map();
  headings.forEach((heading, index) => {
    const start = heading.index + heading[0].length;
    const end = index + 1 < headings.length ? headings[index + 1].index : text.length;
    sections.set(heading[1].trim(), text.slice(start, end));
  });
  return sections;
}

function stripPlaceholders(content) {
  return content.replace(/<!--[\s\S]*?-->/g, '').trim();
}

export function validateBody(body) {
  const errors = [];
  const sections = sectionBodies(body);

  for (const name of REQUIRED_SECTIONS) {
    if (!sections.has(name)) {
      errors.push(`Missing "## ${name}" section — see .github/PULL_REQUEST_TEMPLATE.md.`);
    }
  }

  for (const name of CONTENT_SECTIONS) {
    if (!sections.has(name)) continue;
    const content = stripPlaceholders(sections.get(name));
    if (content.length < MIN_SECTION_LENGTH) {
      errors.push(`"## ${name}" is empty or still just the template placeholder — fill it in.`);
    }
  }

  return errors;
}

export function validate({ title, body }) {
  return [...validateTitle(title), ...validateBody(body)];
}

function main() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    console.error('GITHUB_EVENT_PATH is not set — run this inside a pull_request workflow.');
    writeCheckResult([{ check: 'pr-description', severity: 'error', message: 'GITHUB_EVENT_PATH is not set.' }]);
    process.exit(2);
  }
  const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
  const pr = event.pull_request;
  if (!pr) {
    console.error('Event payload has no pull_request — nothing to validate.');
    writeCheckResult([]);
    process.exit(2);
  }

  const errors = validate({ title: pr.title, body: pr.body });

  if (errors.length === 0) {
    console.log('PR title and description follow the required structure.');
    writeCheckResult([]);
    process.exit(0);
  }

  const report = [
    '### PR description check failed',
    '',
    ...errors.map((error) => `- ${error}`),
    '',
    'See [.github/PULL_REQUEST_TEMPLATE.md](../blob/main/.github/PULL_REQUEST_TEMPLATE.md) for the expected structure and an example.',
  ].join('\n');

  console.error(report);
  writeCheckResult(errors.map((message) => ({ check: 'pr-description', severity: 'error', message, file: '.github/PULL_REQUEST_TEMPLATE.md' })));
  // GITHUB_STEP_SUMMARY is a separate file per step — write to a plain
  // workspace file too so a later step in the same job (e.g. the PR-comment
  // step) can read this report back.
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) fs.appendFileSync(summaryPath, `${report}\n`);
  fs.writeFileSync('.pr-description-report.md', `${report}\n`);
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
