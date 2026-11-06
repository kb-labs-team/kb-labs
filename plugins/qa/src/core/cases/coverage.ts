import type { QACase, QACaseClaim, QACaseCoverage, QACaseMode, QACaseRunResult, QACaseStepResult } from '../../contracts/index.js';

export function computeQACaseCoverage(
  cases: QACase[],
  claims: QACaseClaim[],
  runs: QACaseRunResult[],
  mode: QACaseMode,
): QACaseCoverage {
  const matchingRuns = runs.filter(run => run.mode === mode);
  const coverageCases = cases.map(testCase => {
    if (!testCase.modes.includes(mode)) {
      return { id: testCase.id, title: testCase.title, status: testCase.status, release: testCase.release, statusResult: 'NOT REQUIRED' as const, reason: `Case does not apply to ${mode} mode.`, steps: [] };
    }
    if (testCase.status !== 'active') {
      return { id: testCase.id, title: testCase.title, status: testCase.status, release: testCase.release, statusResult: 'NOT REQUIRED' as const, reason: `${testCase.status} cases are retained for reference and are not gated.`, steps: [] };
    }
    const steps = testCase.steps.map(step => {
      const stepClaims = claims.filter(claim => claim.stepId === step.id);
      const stepRuns = matchingRuns.flatMap(run => run.claims.filter(result => result.claimId === step.id).map(result => ({ ...result, runId: run.runId })));
      const nonUnitClaims = stepClaims.filter(claim => claim.kind !== 'unit');
      const nonUnitPasses = stepRuns.some(result => result.status === 'PASS' && result.kind !== 'unit');
      let status: QACaseStepResult;
      let reason: string | undefined;
      if (stepRuns.some(result => result.status === 'FAIL')) {
        status = 'FAIL';
        reason = `Claimed test run ${stepRuns.find(result => result.status === 'FAIL')?.runId ?? ''} failed.`.trim();
      } else if (stepClaims.length === 0 || (testCase.release && nonUnitClaims.length === 0)) {
        status = 'NOT COVERED';
        reason = stepClaims.length === 0
          ? 'No test claims this case step.'
          : 'Release case needs an executed journey/e2e claim; unit-test claims do not satisfy release coverage.';
      } else if (testCase.release ? nonUnitPasses : stepRuns.some(result => result.status === 'PASS')) {
        status = 'PASS';
      } else {
        status = 'NOT RUN';
        reason = testCase.release && nonUnitClaims.length > 0
          ? 'Journey/e2e claim exists but has no passing run result for this mode.'
          : 'Claimed test has no run result for this mode.';
      }
      return { stepId: step.id, status, ...(reason ? { reason } : {}), claims: stepClaims };
    });
    const statuses = steps.map(step => step.status);
    const statusResult: QACaseCoverage['cases'][number]['statusResult'] = testCase.status !== 'active' ? 'NOT REQUIRED'
      : statuses.includes('FAIL') ? 'FAIL'
        : statuses.includes('NOT COVERED') ? 'NOT COVERED'
          : statuses.includes('NOT RUN') ? 'NOT RUN'
            : 'PASS';
    const reason = statusResult === 'PASS'
      ? undefined
      : steps.find(step => step.status === statusResult)?.reason ?? (statusResult === 'NOT REQUIRED' ? 'Case is not gated.' : undefined);
    return { id: testCase.id, title: testCase.title, status: testCase.status, release: testCase.release, statusResult, ...(reason ? { reason } : {}), steps };
  });
  const releasePassed = coverageCases.every(testCase =>
    testCase.status !== 'active' || !testCase.release || testCase.statusResult === 'PASS' || testCase.statusResult === 'NOT REQUIRED');
  return { schema: 'kb.qa-case-coverage/v1', mode, cases: coverageCases, releasePassed };
}
