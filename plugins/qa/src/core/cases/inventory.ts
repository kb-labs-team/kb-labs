import type { QACase, QACaseClaim } from '../../contracts/index.js';

const EXECUTION_MODELS = ['in-process', 'subprocess', 'worker-pool'] as const;
const OPERATING_SYSTEMS = ['macos', 'linux'] as const;

/**
 * Build a source-backed inventory of case obligations and declared claims.
 * Claims describe test ownership only; they do not prove a run or profile.
 */
export function buildQACaseEvidenceInventory(cases: QACase[], claims: QACaseClaim[]) {
  const steps = cases.flatMap(testCase => testCase.steps.map(step => {
    const stepClaims = claims.filter(claim => claim.stepId === step.id);
    const hasJourneyOrE2EClaim = stepClaims.some(claim => claim.kind === 'journey' || claim.kind === 'e2e');
    return {
      caseId: testCase.id,
      title: testCase.title,
      status: testCase.status,
      release: testCase.release,
      stepId: step.id,
      action: step.action,
      expected: step.expected,
      modes: testCase.modes,
      surfaces: testCase.surfaces,
      claims: stepClaims,
      ownership: stepClaims.length === 0 ? 'UNCLAIMED' as const
        : testCase.release && !hasJourneyOrE2EClaim ? 'UNIT_ONLY' as const
          : 'CLAIMED' as const,
      profileDeclarations: {
        operatingSystem: 'UNDECLARED' as const,
        runtime: 'UNDECLARED' as const,
        executionModel: step.executionModels?.length ? 'DECLARED' as const : 'UNDECLARED' as const,
        requestAndConfigProvenance: 'UNDECLARED' as const,
        candidateArtifactIdentity: 'UNDECLARED' as const,
      },
      profileExpectations: {
        executionModel: {
          required: step.executionModels ?? [],
          evaluation: 'NOT EVALUATED' as const,
        },
      },
    };
  }));

  const activeReleaseSteps = steps.filter(step => step.status === 'active' && step.release);
  const stepsWithExecutionModelDeclaration = steps.filter(step => step.profileDeclarations.executionModel === 'DECLARED').length;
  const declaredProfileDimensions = steps.length > 0 && stepsWithExecutionModelDeclaration === steps.length ? ['executionModel'] : [];
  const partiallyDeclaredProfileDimensions = stepsWithExecutionModelDeclaration > 0 && stepsWithExecutionModelDeclaration < steps.length
    ? ['executionModel']
    : [];
  const missingProfileDimensions = [
    'operatingSystem', 'runtime', 'requestAndConfigProvenance', 'candidateArtifactIdentity',
    ...(stepsWithExecutionModelDeclaration === 0 ? ['executionModel'] : []),
  ];
  return {
    schema: 'kb.qa-case-evidence-inventory/v1' as const,
    policy: {
      release1: {
        requiredMode: 'local' as const,
        supplementalNonGatingMode: 'secured' as const,
        requiredOperatingSystems: [...OPERATING_SYSTEMS],
        executionModels: [...EXECUTION_MODELS],
        executionModelApplicability: 'only-where-relevant' as const,
      },
      sourceDeclarations: {
        caseFields: ['status', 'release', 'modes', 'surfaces'],
        stepProfileFields: ['executionModels'],
        declaredProfileDimensions,
        partiallyDeclaredProfileDimensions,
        missingProfileDimensions,
      },
    },
    totals: {
      cases: cases.length,
      steps: steps.length,
      activeReleaseSteps: activeReleaseSteps.length,
      activeReleaseStepsWithoutClaims: activeReleaseSteps.filter(step => step.ownership === 'UNCLAIMED').length,
      activeReleaseStepsWithoutJourneyOrE2EClaim: activeReleaseSteps.filter(step => !step.claims.some(claim => claim.kind === 'journey' || claim.kind === 'e2e')).length,
    },
    steps,
  };
}
