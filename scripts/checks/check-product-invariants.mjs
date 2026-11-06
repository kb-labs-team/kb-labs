#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeCheckResult } from './lib/check-result.mjs';

const checkName = process.env.KB_DEVKIT_CHECK_NAME;
const invariantCount = 12;
// The check's contract is explicitly INV-01 through INV-12; this is the sole
// owner of the expected set and is intentionally independent of document headings.
const INVARIANT_IDS = Array.from({ length: invariantCount }, (_, index) => `INV-${String(index + 1).padStart(2, '0')}`);
const knownStatuses = new Set(['enforced', 'partial', 'debt']);
const requiredFields = ['Rule', 'Why', 'Enforcement', 'Status'];

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const root = process.cwd();
  const documentPath = path.join(root, 'docs/product/invariants.md');
  if (!existsSync(documentPath)) {
    writeCheckResult([{ check: checkName, severity: 'error', file: 'docs/product/invariants.md', message: 'product invariants document does not exist' }]);
    process.exit(1);
  }
  writeCheckResult(productInvariantIssues(readFileSync(documentPath, 'utf8'), root));
}

export function productInvariantIssues(markdown, root) {
  const issues = [];
  const expectedIds = new Set(INVARIANT_IDS);
  const headings = [...markdown.matchAll(/^## (INV-\d+) — .+$/gm)];
  const counts = new Map();

  for (const heading of headings) {
    const id = heading[1];
    counts.set(id, (counts.get(id) ?? 0) + 1);
    if (!expectedIds.has(id)) {
      addIssue(issues, id, lineAt(markdown, heading.index), `unexpected invariant id ${id}; expected INV-01 through INV-12`);
    }
    if (counts.get(id) > 1) {
      addIssue(issues, id, lineAt(markdown, heading.index), `duplicate invariant id ${id}`);
    }
  }
  for (const id of INVARIANT_IDS) {
    if (!counts.has(id)) addIssue(issues, id, 1, `missing invariant id ${id}`);
  }

  const repositoryRoot = realpathSync(root);
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    const id = heading[1];
    const sectionStart = heading.index + heading[0].length;
    const sectionEnd = headings[index + 1]?.index ?? markdown.length;
    const section = markdown.slice(sectionStart, sectionEnd);
    const line = lineAt(markdown, heading.index);
    const fields = new Map();

    for (const fieldName of requiredFields.concat(['Gap', 'Owner'])) {
      const matches = [...section.matchAll(new RegExp(`^\\*\\*${fieldName}:\\*\\*([^\\n]*)$`, 'gm'))];
      fields.set(fieldName, matches);
      if (fieldName === 'Gap' && matches.length === 0) continue;
      if (fieldName === 'Owner' && matches.length === 0) continue;
      if (matches.length !== 1 || matches[0][1].trim() === '') {
        addIssue(issues, id, line, `requires exactly one non-empty ${fieldName} entry`);
      }
    }

    const statusValue = fields.get('Status')?.[0]?.[1]?.trim();
    if (statusValue && !knownStatuses.has(statusValue)) {
      addIssue(issues, id, line, `unknown status ${statusValue}; expected enforced, partial, or debt`);
    }

    const gapMatches = fields.get('Gap') ?? [];
    const hasGap = gapMatches.length === 1 && gapMatches[0][1].trim() !== '';
    if (statusValue === 'partial' || statusValue === 'debt') {
      if (!hasGap) {
        addIssue(issues, id, line, `${statusValue} status requires a non-empty Gap entry`);
      }
      const ownerMatches = fields.get('Owner') ?? [];
      if (ownerMatches.length !== 1 || ownerMatches[0][1].trim() === '') {
        addIssue(issues, id, line, `${statusValue} status requires exactly one non-empty Owner repository path`);
      } else {
        validateLinks(issues, id, line, ownerMatches[0][1], 'Owner', repositoryRoot, root, true);
      }
    }

    const enforcementMatches = fields.get('Enforcement') ?? [];
    if (enforcementMatches.length === 1 && enforcementMatches[0][1].trim() !== '') {
      validateLinks(issues, id, line, enforcementMatches[0][1], 'Enforcement', repositoryRoot, root, true);
    }
  }
  return issues;
}

function validateLinks(issues, id, line, value, fieldName, repositoryRoot, root, requireLink) {
  const links = [...value.matchAll(/\[[^\]]+\]\(([^)]*)\)/g)];
  if (links.length === 0) {
    if (requireLink) addIssue(issues, id, line, `${fieldName} must link to an existing repository path`);
    return;
  }

  for (const [, rawTarget] of links) {
    const target = rawTarget.trim();
    if (target === '' || /^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith('/') || target.startsWith('\\')) {
      addIssue(issues, id, line, `${fieldName} link must be a non-empty repository-relative path: ${target || '(empty)'}`);
      continue;
    }

    let decodedTarget;
    try {
      decodedTarget = decodeURIComponent(target.split('#', 1)[0]);
    } catch {
      addIssue(issues, id, line, `${fieldName} has an invalid encoded repository path: ${target}`);
      continue;
    }
    const resolvedTarget = path.resolve(root, 'docs/product', decodedTarget);
    const relativeTarget = path.relative(repositoryRoot, resolvedTarget);
    if (relativeTarget === '..' || relativeTarget.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTarget)) {
      addIssue(issues, id, line, `${fieldName} path is outside the repository: ${target}`);
      continue;
    }

    let realTarget;
    try {
      realTarget = realpathSync(resolvedTarget);
    } catch {
      addIssue(issues, id, line, `${id} ${fieldName} path does not exist: ${target}`);
      continue;
    }
    const realRelativeTarget = path.relative(repositoryRoot, realTarget);
    if (realRelativeTarget === '..' || realRelativeTarget.startsWith(`..${path.sep}`) || path.isAbsolute(realRelativeTarget)) {
      addIssue(issues, id, line, `${fieldName} path resolves outside the repository: ${target}`);
    }
  }
}

function addIssue(issues, id, line, message) {
  issues.push({
    check: checkName,
    severity: 'error',
    file: 'docs/product/invariants.md',
    line,
    message: `${id} ${message}`,
  });
}

function lineAt(markdown, offset) {
  return markdown.slice(0, offset).split('\n').length;
}
