import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { QACase, QACaseClaim, QACaseClaimKind } from '../../contracts/index.js';
import type { QACatalogDiagnostic } from './catalog.js';

const CLAIM_ID = /^(?:S|PC)-\d{3}\.\d+$/;
const CLAIM_ID_LITERAL = /["']((?:S|PC)-\d{3}\.\d+)["']/g;
const SKIP = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.kb', '.venv', '.tox', '.pytest_cache', 'vendor', 'coverage']);
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.go', '.py']);
const JOURNEY_CLAIM_DECLARATION_CALLS = new Set([
  'step', 'flow', 'claim_step', 'record_case', 'record', 'blocked', 'record_flow_step',
  'dispatch_step', 'service_check', '_record_step',
]);
const JOURNEY_CASE_EVIDENCE_CALLS = new Set(['run_studio_browser_step']);

function maskPythonCommentsAndDocstrings(source: string): string {
  const characters = source.split('');
  const mask = (start: number, end: number) => {
    for (let position = start; position < end; position += 1) {
      if (characters[position] !== '\n' && characters[position] !== '\r') {characters[position] = ' ';}
    }
  };
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (character === '#') {
      const end = source.indexOf('\n', index);
      const stop = end < 0 ? source.length : end;
      mask(index, stop);
      index = stop;
      continue;
    }
    if (character !== '"' && character !== "'") {
      index += 1;
      continue;
    }

    const triple = source.slice(index, index + 3) === character.repeat(3);
    const delimiter = triple ? character.repeat(3) : character;
    let end = index + delimiter.length;
    while (end < source.length) {
      if (source[end] === '\\') {
        end += 2;
        continue;
      }
      if (source.slice(end, end + delimiter.length) === delimiter) {
        end += delimiter.length;
        break;
      }
      end += 1;
    }
    if (triple) {mask(index, end);}
    index = end;
  }
  return characters.join('');
}

function pythonCallEnd(source: string, openParen: number): number {
  let depth = 0;
  let quote = '';
  for (let index = openParen; index < source.length; index += 1) {
    const character = source[index] ?? '';
    if (quote) {
      if (character === '\\') {index += 1; continue;}
      if (character === quote) {quote = '';}
      continue;
    }
    if (character === '"' || character === "'") {quote = character; continue;}
    if (character === '(') {depth += 1;}
    if (character === ')') {
      depth -= 1;
      if (depth === 0) {return index + 1;}
    }
  }
  return source.length;
}

function pythonCallNameBefore(source: string, position: number): string | undefined {
  let nestedCalls = 0;
  let quote: string | undefined;
  for (let index = position - 1; index >= 0; index -= 1) {
    const character = source[index] ?? '';
    if (quote) {
      if (character === quote) {
        let backslashes = 0;
        for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor -= 1) {backslashes += 1;}
        if (backslashes % 2 === 0) {quote = undefined;}
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === ')') {
      nestedCalls += 1;
      continue;
    }
    if (character === '(') {
      if (nestedCalls > 0) {
        nestedCalls -= 1;
        continue;
      }
      const prefix = source.slice(0, index);
      if (/\b(?:async\s+)?def\s+[A-Za-z_]\w*\s*$/.test(prefix)) {return undefined;}
      return prefix.match(/([A-Za-z_]\w*)\s*$/)?.[1];
    }
  }
  return undefined;
}

function filesUnder(root: string, diagnostics: QACatalogDiagnostic[]): string[] {
  const result: string[] = [];
  const visit = (directory: string) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      diagnostics.push({
        file: relative(process.cwd(), directory),
        line: 1,
        message: `unable to scan case-claim sources: ${message}`,
      });
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !SKIP.has(entry.name)) {visit(join(directory, entry.name));}
      else if (entry.isFile() && SOURCE_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf('.')))) {result.push(join(directory, entry.name));}
    }
  };
  visit(root);
  return result.sort();
}

function validateClaim(claim: QACaseClaim, cases: QACase[], file: string, line: number, diagnostics: QACatalogDiagnostic[]): void {
  const [caseId] = claim.id.split('.');
  const testCase = cases.find(item => item.id === caseId);
  if (!testCase) { diagnostics.push({ file, line, message: `claim references unknown case ${caseId}` }); return; }
  if (!testCase.steps.some(step => step.id === claim.id)) {diagnostics.push({ file, line, message: `claim references unknown step ${claim.id}` });}
}

function parsePythonCaseIds(value: string, cases: QACase[]): { ids: string[]; invalid: boolean } {
  const ids: string[] = [];
  for (const item of value.split(',').map(part => part.trim())) {
    if (CLAIM_ID.test(item)) {
      ids.push(item);
      continue;
    }
    const range = /^((?:S|PC)-\d{3})\.(\d+)-\.(\d+)$/.exec(item);
    if (!range) {return { ids, invalid: true };}
    const caseId = range[1]!;
    const first = Number(range[2]);
    const last = Number(range[3]);
    const testCase = cases.find(candidate => candidate.id === caseId);
    if (!testCase) {
      ids.push(`${caseId}.${first}`);
      continue;
    }
    if (first < 1 || last < first || last - first + 1 > testCase.steps.length) {
      return { ids, invalid: true };
    }
    for (let stepNumber = first; stepNumber <= last; stepNumber += 1) {
      ids.push(`${caseId}.${stepNumber}`);
    }
  }
  return { ids, invalid: ids.length === 0 };
}

export function scanQACaseClaims(root: string, cases: QACase[]): { claims: QACaseClaim[]; diagnostics: QACatalogDiagnostic[] } {
  const claims: QACaseClaim[] = [];
  const diagnostics: QACatalogDiagnostic[] = [];
  for (const filePath of filesUnder(root, diagnostics)) {
    const source = readFileSync(filePath, 'utf8');
    const lines = source.split(/\r?\n/);
    const file = relative(process.cwd(), filePath);
    const sourcePath = relative(root, filePath).replaceAll('\\', '/');
    const isPythonJourneySource = sourcePath.startsWith('e2e/journey/')
      && filePath.endsWith('.py')
      && !sourcePath.split('/').at(-1)!.startsWith('test_');
    const isNativeMacOSJourneySource = sourcePath === 'e2e/journey/native-macos-install.mjs';
    const isJourneySource = isPythonJourneySource || isNativeMacOSJourneySource;
    const isPlaywrightSource = sourcePath.startsWith('e2e/') && filePath.endsWith('.spec.ts');
    const add = (stepId: string, kind: QACaseClaimKind, claimLine: number, testName?: string) => {
      if (!CLAIM_ID.test(stepId)) { diagnostics.push({ file, line: claimLine, message: `invalid case step claim ${stepId}` }); return; }
      const claim = { id: stepId, stepId, kind, source: file, line: claimLine, ...(testName ? { testName } : {}) };
      validateClaim(claim, cases, file, claimLine, diagnostics);
      claims.push(claim);
    };
    if (isJourneySource) {
      const journeySource = isPythonJourneySource ? maskPythonCommentsAndDocstrings(source) : source;
      const claimSpans: Array<{ start: number; end: number }> = [];
      const declaredStepIds = new Set<string>();
      for (const match of (isPythonJourneySource ? journeySource : '').matchAll(/\bcases\s*=\s*\[([^\]]*)\]/g)) {
        const claimLine = journeySource.slice(0, match.index).split(/\r?\n/).length;
        claimSpans.push({ start: match.index!, end: match.index! + match[0].length });
        const callName = pythonCallNameBefore(journeySource, match.index!);
        if (JOURNEY_CASE_EVIDENCE_CALLS.has(callName ?? '')) {continue;}
        if (callName && !JOURNEY_CLAIM_DECLARATION_CALLS.has(callName)) {
          diagnostics.push({ file, line: claimLine,
            message: `case claim must be attached to a registered journey declaration; ${callName} is not a case recorder` });
          continue;
        }
        if (!callName) {
          const ids = [...(match[1] ?? '').matchAll(/["']((?:S|PC)-\d{3}\.\d+)["']/g)];
          if (ids.length > 0) {
            diagnostics.push({ file, line: claimLine,
              message: 'case claim must be attached to a registered journey declaration; cases list is not a declaration call' });
          }
          continue;
        }
        for (const step of (match[1] ?? '').matchAll(/["']((?:S|PC)-\d{3}\.\d+)["']/g)) {
          declaredStepIds.add(step[1]!);
          add(step[1]!, 'journey', claimLine);
        }
      }
      if (isNativeMacOSJourneySource) {
        for (const match of journeySource.matchAll(/\bexport\s+const\s+cases\s*=\s*\[([^\]]*)\]/g)) {
          const claimLine = journeySource.slice(0, match.index).split(/\r?\n/).length;
          claimSpans.push({ start: match.index!, end: match.index! + match[0].length });
          for (const step of (match[1] ?? '').matchAll(/["']((?:S|PC)-\d{3}\.\d+)["']/g)) {
            declaredStepIds.add(step[1]!);
            add(step[1]!, 'journey', claimLine);
          }
        }
      }
      // Installer fixture steps use a helper that turns a positional step ID
      // into Journey.step(..., cases=[step_id]); preserve its callsite claim.
      for (const match of journeySource.matchAll(/\bexact_step\s*\(\s*["']((?:S|PC)-\d{3}\.\d+)["']/g)) {
        const claimLine = journeySource.slice(0, match.index).split(/\r?\n/).length;
        declaredStepIds.add(match[1]!);
        add(match[1]!, 'journey', claimLine);
        const openParen = journeySource.indexOf('(', match.index);
        claimSpans.push({ start: match.index, end: pythonCallEnd(journeySource, openParen) });
      }
      for (const match of journeySource.matchAll(CLAIM_ID_LITERAL)) {
        if (claimSpans.some(span => match.index! >= span.start && match.index! < span.end)
            || declaredStepIds.has(match[1]!)) {continue;}
        const claimLine = journeySource.slice(0, match.index).split(/\r?\n/).length;
        diagnostics.push({ file, line: claimLine,
          message: 'case claim outside a literal cases=[...]; the validator cannot see it' });
      }
    }
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      if (filePath.endsWith('.py')) {
        const firstComment = line.match(/^\s*#\s*case:\s*(.+)$/);
        if (!firstComment) {continue;}
        const pythonClaims: string[] = [];
        let commentIndex = index;
        let invalid = false;
        while (commentIndex < lines.length) {
          const comment = (lines[commentIndex] ?? '').match(/^\s*#\s*case:\s*(.+)$/);
          if (!comment) {break;}
          const parsed = parsePythonCaseIds(comment[1]!, cases);
          pythonClaims.push(...parsed.ids);
          invalid ||= parsed.invalid;
          commentIndex += 1;
        }
        const testLine = (lines[commentIndex] ?? '').match(/^\s*(?:async\s+)?def\s+(test\w+)/);
        if (!testLine) {
          diagnostics.push({ file, line: index + 1, message: '# case: must be directly above a Python test function' });
        } else if (invalid) {
          diagnostics.push({ file, line: index + 1, message: '# case: expected a case step or inclusive case step range' });
        } else {
          for (const stepId of pythonClaims) {add(stepId, 'unit', commentIndex + 1, testLine[1]!);}
        }
        index = commentIndex - 1;
        continue;
      }
      // Playwright titles carry tags at the title or describe block boundary.
      if (isPlaywrightSource && /\b(?:test|it)\s*\(/.test(line)) {
        const name = line.match(/\b(?:test|it)\s*\(\s*["'`]([^"'`]+)/)?.[1];
        for (const match of line.matchAll(/@((?:S|PC)-\d{3}\.\d+)/g)) {add(match[1]!, 'e2e', index + 1, name);}
      }
      // A unit test claim must sit immediately above a test declaration.
      const caseComment = line.match(/^\s*\/\/\s*case:\s*((?:S|PC)-\d{3}\.\d+)\s*$/);
      if (caseComment && filePath.endsWith('.go')) {
        const next = lines[index + 1] ?? '';
        const testLine = next.match(/^\s*func\s+(Test\w+)/);
        if (!testLine) {diagnostics.push({ file, line: index + 1, message: '// case: must be directly above a Go test function' });}
        else {add(caseComment[1]!, 'unit', index + 1, testLine[1]!);}
      } else if (caseComment) {
        const next = lines[index + 1] ?? '';
        const testLine = next.match(/\b(?:test|it)(?:\.each\([^)]*\))?\s*\(\s*(?:["'`]([^"'`]+)|\([^)]*\)\s*=>)/);
        const multilineParameterizedTest = next.match(/^\s*(?:test|it)\.each\s*\(/);
        if (!testLine && !multilineParameterizedTest) {diagnostics.push({ file, line: index + 1, message: '// case: must be directly above a test declaration' });}
        else {add(caseComment[1]!, 'unit', index + 1, testLine?.[1] ?? 'parameterized test');}
      }
    }
  }
  return { claims, diagnostics };
}
