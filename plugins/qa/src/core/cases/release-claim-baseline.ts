import type { QACase, QACaseClaim } from '../../contracts/index.js';
import type { QACatalogDiagnostic } from './catalog.js';

/** Active release steps retained here until the installed journey can prove them. */
export const RELEASE_CASE_CLAIM_BASELINE = [
  'S-054.9',
] as const;

const BASELINE_SOURCE = 'plugins/qa/src/core/cases/release-claim-baseline.ts';

export function validateReleaseCaseClaims(
  cases: QACase[],
  claims: QACaseClaim[],
  baselineEntries: readonly string[] = RELEASE_CASE_CLAIM_BASELINE,
  baselineSource = BASELINE_SOURCE,
): QACatalogDiagnostic[] {
  const releaseCases = cases.filter(testCase => testCase.status === 'active' && testCase.release);
  const journeyClaimed = new Set(claims.filter(claim => claim.kind === 'journey' || claim.kind === 'e2e').map(claim => claim.stepId));
  const violations = new Map<string, QACase['steps'][number]>();
  const caseByStep = new Map<string, QACase>();
  for (const testCase of releaseCases) {
    for (const step of testCase.steps) {
      caseByStep.set(step.id, testCase);
      if (!journeyClaimed.has(step.id)) {violations.set(step.id, step);}
    }
  }

  const diagnostics: QACatalogDiagnostic[] = [];
  const baseline = new Set<string>();
  for (const [index, stepId] of baselineEntries.entries()) {
    if (baseline.has(stepId)) {
      diagnostics.push({ file: baselineSource, line: index + 6, message: `duplicate release claim baseline entry ${stepId}` });
      continue;
    }
    baseline.add(stepId);
    if (!violations.has(stepId)) {
      diagnostics.push({ file: baselineSource, line: index + 6, message: `stale release claim baseline entry ${stepId}; remove it` });
    }
  }

  for (const [stepId, step] of violations) {
    if (baseline.has(stepId)) {continue;}
    const testCase = caseByStep.get(stepId)!;
    diagnostics.push({ file: testCase.file, line: step.line, message: `active release step ${stepId} has no journey or Playwright claim` });
  }
  return diagnostics;
}
