import { resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseQACatalog } from '../../plugins/qa/src/core/cases/catalog.ts';
import { scanQACaseClaims } from '../../plugins/qa/src/core/cases/claims.ts';

export function validateJourneyCaseDeclarations(root = process.cwd()) {
  const catalogPath = resolve(root, 'docs/qa/scenarios');
  const catalog = parseQACatalog(catalogPath);
  const scan = scanQACaseClaims(root, catalog.cases);
  const journeyDiagnostics = scan.diagnostics.filter((diagnostic) => {
    const sourcePath = relative(root, resolve(process.cwd(), diagnostic.file));
    return sourcePath.startsWith('e2e/journey/');
  });
  return {
    caseCount: catalog.cases.length,
    journeyClaimCount: scan.claims.filter((claim) => claim.source.startsWith('e2e/journey/')).length,
    diagnostics: [...catalog.diagnostics, ...journeyDiagnostics],
  };
}

export function validateSelectedJourneyCases(root = process.cwd(), requested = '') {
  const casesPath = resolve(root, 'docs/qa/scenarios');
  const catalog = parseQACatalog(casesPath);
  const scanned = scanQACaseClaims(root, catalog.cases);
  const caseById = new Map(catalog.cases.map((testCase) => [testCase.id, testCase]));
  const journeyClaims = new Set(scanned.claims
    .filter((claim) => relative(root, resolve(process.cwd(), claim.source)).startsWith('e2e/journey/'))
    .map((claim) => claim.id));
  const tokens = requested.split(',').map((token) => token.trim()).filter(Boolean);
  if (tokens.length === 0) throw new Error('selected journey case list is empty');

  for (const token of tokens) {
    const caseId = token.match(/^(S|PC)-\d{3}$/)?.[0]
      ?? token.match(/^((?:S|PC)-\d{3})\.\d+$/)?.[1];
    const testCase = caseId ? caseById.get(caseId) : undefined;
    if (!testCase) throw new Error(`selected journey case/step ${token} is absent from the QA catalog`);
    if (testCase.status !== 'active') {
      throw new Error(`selected journey case ${caseId} is ${testCase.status}; only active cases are selectable`);
    }
    const selectedSteps = token === caseId
      ? testCase.steps.map((step) => step.id)
      : testCase.steps.filter((step) => step.id === token).map((step) => step.id);
    if (selectedSteps.length === 0) throw new Error(`selected journey step ${token} is absent from ${caseId}`);
    const unclaimed = selectedSteps.filter((stepId) => !journeyClaims.has(stepId));
    if (unclaimed.length > 0) {
      throw new Error(`selected journey case ${caseId} has no journey claim for: ${unclaimed.join(', ')}`);
    }
  }
  return { selected: tokens };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'selection') {
    try {
      const selection = process.argv[3] ?? 'full';
      if (selection === 'full') {
        process.stdout.write('Full journey selection does not need a selected-case preflight.\n');
      } else if (selection.startsWith('cases:')) {
        const encoded = selection.slice('cases:'.length).replace(/-/g, '+').replace(/_/g, '/');
        const requested = Buffer.from(encoded, 'base64').toString('utf8');
        validateSelectedJourneyCases(process.cwd(), requested);
        process.stdout.write(`Selected journey case(s) are active and claimed: ${requested}\n`);
      } else {
        throw new Error(`unknown journey selection ${selection}`);
      }
    } catch (error) {
      process.stderr.write(`Selected journey case preflight failed: ${error.message}\n`);
      process.exitCode = 1;
    }
  } else {
  const result = validateJourneyCaseDeclarations();
  if (result.diagnostics.length > 0) {
    process.stderr.write(`Journey case declaration preflight found ${result.diagnostics.length} issue(s):\n`);
    for (const diagnostic of result.diagnostics) {
      process.stderr.write(`${diagnostic.file}:${diagnostic.line}: ${diagnostic.message}\n`);
    }
    process.exitCode = 1;
  } else {
    process.stdout.write(`Validated ${result.caseCount} case(s) and ${result.journeyClaimCount} journey claim(s).\n`);
  }
  }
}
