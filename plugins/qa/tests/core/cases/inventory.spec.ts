import { describe, expect, it } from 'vitest';
import type { QACase, QACaseClaim } from '../../../src/contracts/index.js';
import { buildQACaseEvidenceInventory } from '../../../src/core/cases/inventory.js';

function makeCase(id: string, release: boolean): QACase {
  return {
    id, title: id, persona: 'developer', area: 'qa', priority: 'P1', status: 'active', release,
    modes: ['local'], surfaces: ['cli'], file: `docs/qa/scenarios/${id}.md`,
    steps: [{ id: `${id}.1`, action: 'inspect', expected: 'inventory is shown', line: 1 }],
  };
}

describe('buildQACaseEvidenceInventory', () => {
  // case: S-314.1
  it('reports declared claims separately from missing profile and evidence provenance dimensions', () => {
    const cases = [makeCase('S-314', false), makeCase('S-400', true)];
    const claims: QACaseClaim[] = [{
      id: 'S-400.1', stepId: 'S-400.1', kind: 'unit', source: 'src/example.test.ts', line: 12,
    }];

    const inventory = buildQACaseEvidenceInventory(cases, claims);

    expect(inventory.schema).toBe('kb.qa-case-evidence-inventory/v1');
    expect(inventory.policy.release1).toEqual({
      requiredMode: 'local', supplementalNonGatingMode: 'secured',
      requiredOperatingSystems: ['macos', 'linux'],
      executionModels: ['in-process', 'subprocess', 'worker-pool'],
      executionModelApplicability: 'only-where-relevant',
    });
    expect(inventory.totals).toMatchObject({
      cases: 2, steps: 2, activeReleaseSteps: 1,
      activeReleaseStepsWithoutClaims: 0,
      activeReleaseStepsWithoutJourneyOrE2EClaim: 1,
    });
    expect(inventory.steps[1]).toMatchObject({
      stepId: 'S-400.1', ownership: 'UNIT_ONLY',
      profileDeclarations: {
        operatingSystem: 'UNDECLARED', runtime: 'UNDECLARED', executionModel: 'UNDECLARED',
        requestAndConfigProvenance: 'UNDECLARED', candidateArtifactIdentity: 'UNDECLARED',
      },
    });
  });

  // case: S-314.1
  it('does not treat a claim as a passing run result', () => {
    const inventory = buildQACaseEvidenceInventory([makeCase('S-400', true)], [{
      id: 'S-400.1', stepId: 'S-400.1', kind: 'journey', source: 'journey.py', line: 9,
    }]);
    expect(inventory.steps[0]).toMatchObject({ ownership: 'CLAIMED' });
    expect(inventory.steps[0]).not.toHaveProperty('runStatus');
  });

  // case: S-243.6
  it('reports declared backend applicability as an unevaluated expectation and does not infer OS', () => {
    const testCase = makeCase('S-243', true);
    testCase.steps[0]!.executionModels = ['in-process', 'subprocess', 'worker-pool'];
    const inventory = buildQACaseEvidenceInventory([testCase], []);

    expect(inventory.steps[0]).toMatchObject({
      profileDeclarations: { operatingSystem: 'UNDECLARED', executionModel: 'DECLARED' },
      profileExpectations: {
        executionModel: {
          required: ['in-process', 'subprocess', 'worker-pool'],
          evaluation: 'NOT EVALUATED',
        },
      },
    });
    expect(inventory.steps[0]).not.toHaveProperty('profileExpectations.executionModel.result', 'PASS');
  });
});
