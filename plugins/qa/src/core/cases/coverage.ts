import type { QACase, QACaseClaim, QACaseCoverage, QACaseEvidenceCoverage, QACaseEvidenceRunResult, QACaseMode, QACaseRunResult, QACaseStepResult } from '../../contracts/index.js';

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

export function computeQACaseEvidenceCoverage(
  cases: QACase[],
  claims: QACaseClaim[],
  runs: QACaseEvidenceRunResult[],
  mode: QACaseMode,
): QACaseEvidenceCoverage {
  const legacy = computeQACaseCoverage(cases, claims, runs.map(run => ({
    schema: 'kb.qa-case-run/v2' as const,
    runId: run.runId,
    mode: run.mode,
    claims: run.claims.map(({ claimId, kind, status }) => ({ claimId, kind, status })),
  })), mode);
  const matchingRuns = runs.filter(run => run.mode === mode);
  const candidates = new Set(matchingRuns.map(run => run.candidateId).filter((value): value is string => Boolean(value)));
  const profiles = new Set(matchingRuns.map(run => JSON.stringify(Object.entries(run.profile ?? {}).sort(([a], [b]) => a.localeCompare(b)))));
  const identityMatches = candidates.size <= 1 && profiles.size <= 1;
  const coverageCases = legacy.cases.map(testCase => ({
    ...testCase,
    steps: testCase.steps.map(step => {
      const result = matchingRuns.flatMap(run => run.claims
        .filter(claim => claim.claimId === step.stepId && (!testCase.release || claim.kind !== 'unit'))
        .map(claim => ({ claim, candidateId: run.candidateId, profile: run.profile })))[0];
      const evidenceComplete = Boolean(result?.candidateId && result.profile && Object.keys(result.profile).length > 0
        && result.claim.configRef && result.claim.logRef && identityMatches);
      return {
        ...step,
        evidenceStatus: evidenceComplete ? 'COMPLETE' as const : 'INCOMPLETE' as const,
        ...(result?.candidateId ? { candidateId: result.candidateId } : {}),
        ...(result?.profile ? { profile: result.profile } : {}),
        ...(result?.claim.configRef ? { configRef: result.claim.configRef } : {}),
        ...(result?.claim.logRef ? { logRef: result.claim.logRef } : {}),
        ...(!evidenceComplete ? { reason: [step.reason, !identityMatches ? 'Evidence records use mismatched candidate or profile identities.' : undefined, 'Required candidate, profile, config, or log evidence is missing.'].filter(Boolean).join(' ') } : {}),
      };
    }),
  }));
  const evidencePassed = coverageCases.every(testCase => testCase.status !== 'active' || !testCase.release
    || testCase.statusResult === 'NOT REQUIRED'
    || testCase.steps.every(step => step.evidenceStatus === 'COMPLETE'));
  return {
    schema: 'kb.qa-case-coverage/v2',
    mode,
    cases: coverageCases,
    releasePassed: legacy.releasePassed && evidencePassed,
    evidencePassed,
  };
}
