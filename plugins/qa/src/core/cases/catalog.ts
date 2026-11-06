import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { QACase, QACaseMode, QACasePriority, QACaseStatus, QACaseSurface } from '../../contracts/index.js';

const CASE_ID = /^(?:S|PC)-\d{3}$/;
const STEP_ID = /^((?:S|PC)-\d{3})\.(\d+)$/;
const FIELDS = ['id', 'title', 'persona', 'area', 'priority', 'status', 'release', 'modes', 'surfaces', 'superseded_by'];
const REQUIRED_FIELDS = ['id', 'title', 'persona', 'area', 'priority', 'status', 'release', 'modes', 'surfaces'];

export interface QACatalogDiagnostic { file: string; line: number; message: string }
export interface QACatalogResult { cases: QACase[]; diagnostics: QACatalogDiagnostic[] }

function diagnostic(file: string, line: number, message: string): QACatalogDiagnostic {
  return { file, line, message };
}

function scalar(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function list(value: string | undefined, lines: string[], start: number): string[] {
  if (value === undefined) {return [];}
  const inline = value.match(/^\[([^\]]*)\]$/);
  if (inline) {return (inline[1] ?? '').split(',').map(scalar).filter(Boolean);}
  const result: string[] = [];
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (!/^\s+-\s+/.test(line)) {break;}
    result.push(scalar(line.replace(/^\s+-\s+/, '')));
  }
  return result;
}

function parseCase(file: string, source: string, errors: QACatalogDiagnostic[]): QACase | undefined {
  const lines = source.split(/\r?\n/);
  if (lines[0] !== '---') {
    errors.push(diagnostic(file, 1, 'missing YAML frontmatter opening delimiter'));
    return undefined;
  }
  const close = lines.indexOf('---', 1);
  if (close < 0) {
    errors.push(diagnostic(file, 1, 'missing YAML frontmatter closing delimiter'));
    return undefined;
  }
  const values = new Map<string, { value: string; line: number }>();
  let invalid = false;
  for (let i = 1; i < close; i += 1) {
    const line = lines[i] ?? '';
    const match = line.match(/^([a-zA-Z][\w-]*):(?:\s*(.*))?$/);
    if (!match) {
      errors.push(diagnostic(file, i + 1, 'invalid frontmatter field; expected `key: value`'));
      invalid = true;
      continue;
    }
    const key = match[1] ?? '';
    if (values.has(key)) {
      errors.push(diagnostic(file, i + 1, `duplicate frontmatter field ${key}`));
      invalid = true;
    }
    values.set(key, { value: match[2] ?? '', line: i + 1 });
  }
  for (const key of values.keys()) {
    if (!FIELDS.includes(key)) {
      errors.push(diagnostic(file, values.get(key)!.line, `unknown frontmatter field ${key}`));
      invalid = true;
    }
  }
  for (const key of REQUIRED_FIELDS) {
    if (!values.has(key)) {
      errors.push(diagnostic(file, 2, `missing required frontmatter field ${key}`));
      invalid = true;
    }
  }
  const value = (key: string) => scalar(values.get(key)?.value ?? '');
  const id = value('id');
  if (!CASE_ID.test(id)) { errors.push(diagnostic(file, values.get('id')?.line ?? 1, `invalid case id ${id}; expected S-010 or PC-001`)); invalid = true; }
  const priority = value('priority');
  if (!['P0', 'P1', 'P2'].includes(priority)) { errors.push(diagnostic(file, values.get('priority')?.line ?? 1, 'priority must be P0, P1, or P2')); invalid = true; }
  const status = value('status');
  if (!['active', 'planned', 'draft', 'historical'].includes(status)) { errors.push(diagnostic(file, values.get('status')?.line ?? 1, 'status must be active, planned, draft, or historical')); invalid = true; }
  const release = value('release');
  if (!['true', 'false'].includes(release)) { errors.push(diagnostic(file, values.get('release')?.line ?? 1, 'release must be true or false')); invalid = true; }
  if (status === 'draft' && release !== 'false') { errors.push(diagnostic(file, values.get('release')?.line ?? 1, 'draft cases must set release: false')); invalid = true; }
  const modes = list(values.get('modes')?.value, lines, (values.get('modes')?.line ?? 0));
  const surfaces = list(values.get('surfaces')?.value, lines, (values.get('surfaces')?.line ?? 0));
  const supersededBy = value('superseded_by');
  for (const key of ['title', 'persona', 'area']) {
    if (!value(key)) { errors.push(diagnostic(file, values.get(key)?.line ?? 1, `${key} must not be empty`)); invalid = true; }
  }
  if (!modes.length || modes.some(mode => !['local', 'secured'].includes(mode))) { errors.push(diagnostic(file, values.get('modes')?.line ?? 1, 'modes must contain local and/or secured')); invalid = true; }
  if (!surfaces.length || surfaces.some(surface => !['cli', 'studio', 'api', 'agent'].includes(surface))) { errors.push(diagnostic(file, values.get('surfaces')?.line ?? 1, 'surfaces must contain cli, studio, api, and/or agent')); invalid = true; }
  if (supersededBy && status !== 'historical') { errors.push(diagnostic(file, values.get('superseded_by')?.line ?? 1, 'superseded_by is only valid for historical cases')); invalid = true; }
  if (supersededBy && !CASE_ID.test(supersededBy)) { errors.push(diagnostic(file, values.get('superseded_by')?.line ?? 1, `invalid superseded_by case id ${supersededBy}`)); invalid = true; }

  const steps: QACase['steps'] = [];
  let inSteps = false;
  for (let i = close + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (/^##\s+Steps\s*$/.test(line)) { inSteps = true; continue; }
    if (inSteps && /^##\s+/.test(line)) {break;}
    if (!inSteps || !/^\s*\|/.test(line) || /^\s*\|\s*[-:| ]+\|?\s*$/.test(line)) {continue;}
    const cells = line.split('|').slice(1, -1).map(cell => cell.trim());
    if (cells.length < 3 || cells[0] === '#') {continue;}
    const stepId = cells[0] ?? '';
    const action = cells[1] ?? '';
    const expected = cells[2] ?? '';
    const parsed = STEP_ID.exec(stepId);
    if (!parsed || parsed[1] !== id) {
      errors.push(diagnostic(file, i + 1, `step id ${stepId || '(empty)'} must use ${id}.<number>`)); invalid = true; continue;
    }
    if (!action || !expected) { errors.push(diagnostic(file, i + 1, `step ${stepId} needs an action and a user-visible expected outcome`)); invalid = true; continue; }
    if (steps.some(step => step.id === stepId)) { errors.push(diagnostic(file, i + 1, `duplicate step id ${stepId}`)); invalid = true; continue; }
    steps.push({ id: stepId, action, expected, line: i + 1 });
  }
  if (!steps.length && status !== 'historical') { errors.push(diagnostic(file, close + 1, 'Steps section has no step rows')); invalid = true; }
  if (invalid) {return undefined;}
  return {
    id, title: value('title'), persona: value('persona'), area: value('area'),
    priority: priority as QACasePriority, status: status as QACaseStatus, release: release === 'true',
    modes: modes as QACaseMode[], surfaces: surfaces as QACaseSurface[], ...(supersededBy ? { supersededBy } : {}), file, steps,
  };
}

export function parseQACatalog(directory: string): QACatalogResult {
  const cases: QACase[] = [];
  const diagnostics: QACatalogDiagnostic[] = [];
  let files: string[];
  try {
    files = readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith('.md')).map(entry => join(directory, entry.name)).sort();
  } catch {
    return { cases, diagnostics: [diagnostic(directory, 1, 'catalog directory cannot be read')] };
  }
  if (files.length === 0) {return { cases, diagnostics: [diagnostic(directory, 1, 'catalog contains no Markdown case files')] };}
  const ids = new Set<string>();
  for (const filePath of files) {
    const file = relative(process.cwd(), filePath);
    const result = parseCase(file, readFileSync(filePath, 'utf8'), diagnostics);
    if (!result) {continue;}
    if (ids.has(result.id)) {diagnostics.push(diagnostic(file, 1, `duplicate case id ${result.id}`));}
    else { ids.add(result.id); cases.push(result); }
  }
  for (const testCase of cases) {
    if (testCase.supersededBy && !ids.has(testCase.supersededBy)) {
      const line = readFileSync(join(directory, testCase.file.split('/').pop() ?? ''), 'utf8').split(/\r?\n/).findIndex(line => /^superseded_by:/.test(line)) + 1;
      diagnostics.push(diagnostic(testCase.file, line || 1, `superseded_by references unknown case ${testCase.supersededBy}`));
    }
  }
  return { cases, diagnostics };
}
