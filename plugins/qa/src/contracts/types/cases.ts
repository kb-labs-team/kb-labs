export type QACasePriority = 'P0' | 'P1' | 'P2';
export type QACaseStatus = 'active' | 'planned' | 'draft' | 'historical';
export type QACaseMode = 'local' | 'secured';
export type QACaseSurface = 'cli' | 'studio' | 'api' | 'agent';
export type QACaseClaimKind = 'journey' | 'e2e' | 'unit';
export type QACaseStepResult = 'PASS' | 'FAIL' | 'NOT RUN' | 'NOT COVERED';

export interface QACaseStep {
  id: string;
  action: string;
  expected: string;
  line: number;
}

export interface QACase {
  id: string;
  title: string;
  persona: string;
  area: string;
  priority: QACasePriority;
  status: QACaseStatus;
  release: boolean;
  modes: QACaseMode[];
  surfaces: QACaseSurface[];
  supersededBy?: string;
  file: string;
  steps: QACaseStep[];
}

export interface QACaseClaim {
  id: string;
  stepId: string;
  kind: QACaseClaimKind;
  source: string;
  line: number;
  testName?: string;
}

export const QA_CASE_RUN_SCHEMA = 'kb.qa-case-run/v2' as const;

export interface QACaseRunResult {
  schema: typeof QA_CASE_RUN_SCHEMA;
  runId: string;
  mode: QACaseMode;
  claims: Array<{ claimId: string; kind: QACaseClaimKind; status: 'PASS' | 'FAIL' }>;
}

export interface QACaseStepCoverage {
  stepId: string;
  status: QACaseStepResult;
  reason?: string;
  claims: QACaseClaim[];
}

export interface QACaseCoverage {
  schema: 'kb.qa-case-coverage/v1';
  mode: QACaseMode;
  cases: Array<{
    id: string;
    title: string;
    status: QACaseStatus;
    release: boolean;
    statusResult: 'PASS' | 'FAIL' | 'NOT RUN' | 'NOT COVERED' | 'NOT REQUIRED';
    reason?: string;
    steps: QACaseStepCoverage[];
  }>;
  releasePassed: boolean;
}

/** Versioned schema for `kb qa coverage show --json`. */
export const QA_CASE_COVERAGE_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://kb-labs.dev/schemas/qa-case-coverage-v1.json',
  title: 'KB Labs QA case coverage',
  type: 'object',
  required: ['schema', 'mode', 'cases', 'releasePassed'],
  properties: {
    schema: { const: 'kb.qa-case-coverage/v1' },
    mode: { enum: ['local', 'secured'] },
    releasePassed: { type: 'boolean' },
    cases: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'title', 'status', 'release', 'statusResult', 'steps'],
        properties: {
          id: { type: 'string', pattern: '^(S|PC)-[0-9]{3}$' },
          title: { type: 'string' },
          status: { enum: ['active', 'planned', 'draft', 'historical'] },
          release: { type: 'boolean' },
          statusResult: { enum: ['PASS', 'FAIL', 'NOT RUN', 'NOT COVERED', 'NOT REQUIRED'] },
          reason: { type: 'string' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              required: ['stepId', 'status', 'claims'],
              properties: {
                stepId: { type: 'string', pattern: '^(S|PC)-[0-9]{3}\\.[0-9]+$' },
                status: { enum: ['PASS', 'FAIL', 'NOT RUN', 'NOT COVERED'] },
                reason: { type: 'string' },
                claims: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['id', 'stepId', 'kind', 'source', 'line'],
                    properties: {
                      id: { type: 'string' },
                      stepId: { type: 'string' },
                      kind: { enum: ['journey', 'e2e', 'unit'] },
                      source: { type: 'string' },
                      line: { type: 'integer', minimum: 1 },
                      testName: { type: 'string' },
                    },
                    additionalProperties: false,
                  },
                },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
} as const;
