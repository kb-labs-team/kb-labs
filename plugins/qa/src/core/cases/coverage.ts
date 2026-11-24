import { dirname } from 'node:path';
import type { QACase, QACaseClaim, QACaseCoverage, QACaseEvidenceCoverage, QACaseEvidencePlan, QACaseEvidenceRunResult, QACaseMode, QACaseRunResult, QACaseStepResult } from '../../contracts/index.js';

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
  expectedPlan?: QACaseEvidencePlan,
): QACaseEvidenceCoverage {
  const legacy = computeQACaseCoverage(cases, claims, runs.map(run => ({
    schema: 'kb.qa-case-run/v2' as const,
    runId: run.runId,
    mode: run.mode,
    claims: run.claims.map(({ claimId, kind, status }) => ({ claimId, kind, status })),
  })), mode);
  const matchingRuns = runs.filter(run => run.mode === mode);
  const profileKey = (profile: Record<string, string> | undefined): string => JSON.stringify(Object.entries(profile ?? {}).sort(([a], [b]) => a.localeCompare(b)));
  const planValid = Boolean(expectedPlan && expectedPlan.schema === 'kb.qa-evidence-plan/v1' && expectedPlan.mode === mode
    && typeof expectedPlan.candidateId === 'string' && expectedPlan.candidateId.trim()
    && typeof expectedPlan.profile === 'object' && expectedPlan.profile !== null && !Array.isArray(expectedPlan.profile) && Object.keys(expectedPlan.profile).length > 0
    && Object.values(expectedPlan.profile).every(value => typeof value === 'string' && value.trim()));
  const identityMatches = Boolean(planValid && matchingRuns.length > 0
    && matchingRuns.every(run => run.candidateId === expectedPlan?.candidateId
      && profileKey(run.profile) === profileKey(expectedPlan?.profile)
      && Boolean(run.runId.trim() && run.recordPath?.trim())));
  const coverageCases = legacy.cases.map(testCase => ({
    ...testCase,
    steps: testCase.steps.map(step => {
      const stepResults = matchingRuns.flatMap(run => run.claims
        .filter(claim => claim.claimId === step.stepId)
        .map(claim => ({ claim, candidateId: run.candidateId, runId: run.runId, recordPath: run.recordPath })));
      const evidenceResults = step.status === 'FAIL'
        ? stepResults.filter(result => result.claim.status === 'FAIL')
        : step.status === 'PASS'
          ? stepResults.filter(result => result.claim.status === 'PASS' && (!testCase.release || result.claim.kind !== 'unit'))
          : [];
      const evidenceComplete = Boolean(identityMatches && evidenceResults.length > 0 && evidenceResults.every(result =>
        result.claim.configVerified === true && result.claim.configRef && result.claim.configDigest
          && result.claim.logVerified === true && result.claim.logRef && result.claim.logDigest));
      const artifactRefs = (kind: 'config' | 'log') => [...new Map(evidenceResults.flatMap(result => {
        const reference = kind === 'config' ? result.claim.configRef : result.claim.logRef;
        const digest = kind === 'config' ? result.claim.configDigest : result.claim.logDigest;
        if (!result.claim[`${kind}Verified`] || !reference || !digest || !result.runId || !result.recordPath) return [];
        const artifact = { runId: result.runId, runRoot: dirname(result.recordPath), path: reference, sha256: digest };
        return [[JSON.stringify(artifact), artifact] as const];
      })).values()];
      const configRefs = artifactRefs('config');
      const logRefs = artifactRefs('log');
      const observedCandidateIds = [...new Set(stepResults.map(result => result.candidateId).filter((value): value is string => Boolean(value)))];
      return {
        ...step,
        evidenceStatus: evidenceComplete ? 'COMPLETE' as const : 'INCOMPLETE' as const,
        ...(expectedPlan ? { expectedCandidateId: expectedPlan.candidateId, expectedProfile: expectedPlan.profile } : {}),
        observedCandidateIds,
        configRefs,
        logRefs,
        ...(!evidenceComplete ? { reason: [step.reason, !expectedPlan ? 'Independent expected evidence plan is missing.' : undefined, !identityMatches ? 'Evidence records do not match the independent candidate and profile plan.' : undefined, 'Required verified config and log artifacts are missing.'].filter(Boolean).join(' ') } : {}),
      };
    }),
  }));
  const evidencePassed = coverageCases.every(testCase => testCase.status !== 'active' || !testCase.release
    || testCase.statusResult === 'NOT REQUIRED'
    || testCase.steps.every(step => step.evidenceStatus === 'COMPLETE'));
  const requiredCases = cases.filter(testCase => testCase.status === 'active' && testCase.release && testCase.modes.includes(mode));
  const hasRequiredMatrix = requiredCases.length > 0 && requiredCases.every(testCase => testCase.steps.length > 0);
  return {
    schema: 'kb.qa-case-coverage/v2',
    mode,
    cases: coverageCases,
    releasePassed: legacy.releasePassed && evidencePassed && hasRequiredMatrix && planValid,
    evidencePassed: evidencePassed && hasRequiredMatrix && planValid,
  };
}
