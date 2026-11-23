export type QACasePriority = 'P0' | 'P1' | 'P2';
export type QACaseStatus = 'active' | 'planned' | 'draft' | 'historical';
export type QACaseMode = 'local' | 'secured';
export type QACaseSurface = 'cli' | 'studio' | 'api' | 'agent';
export type QACaseExecutionModel = 'in-process' | 'subprocess' | 'worker-pool';
export type QACaseClaimKind = 'journey' | 'e2e' | 'unit';
export function isQACaseClaimKind(value: unknown): value is QACaseClaimKind {
  return value === 'journey' || value === 'e2e' || value === 'unit';
}
export type QACaseStepResult = 'PASS' | 'FAIL' | 'NOT RUN' | 'NOT COVERED';

export interface QACaseStep {
  id: string;
  action: string;
  expected: string;
  line: number;
  executionModels?: QACaseExecutionModel[];
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

export const QA_CASE_EVIDENCE_RUN_SCHEMA = 'kb.qa-case-run/v3' as const;

export interface QACaseEvidenceRunResult {
  schema: typeof QA_CASE_EVIDENCE_RUN_SCHEMA;
  runId: string;
  mode: QACaseMode;
  candidateId?: string;
  profile?: Record<string, string>;
  /** Requested case/step selection retained for partial-run diagnostics. */
  selection?: string[];
  /** Relative path identifying the run record that owns its artifact references. */
  recordPath?: string;
  claims: Array<{
    claimId: string;
    kind: QACaseClaimKind;
    status: 'PASS' | 'FAIL';
    configRef?: string;
    configDigest?: string;
    /** Set by the CLI after the referenced file passes digest verification. */
    configVerified?: boolean;
    logRef?: string;
    logDigest?: string;
    /** Set by the CLI after the referenced file passes digest verification. */
    logVerified?: boolean;
  }>;
}

export interface QACaseEvidenceArtifactRef {
  runId: string;
  runRoot: string;
  path: string;
  sha256: string;
}

export interface QACaseEvidencePlan {
  schema: 'kb.qa-evidence-plan/v1';
  mode: QACaseMode;
  candidateId: string;
  profile: Record<string, string>;
}

export const QA_CASE_EVIDENCE_PLAN_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://kb-labs.dev/schemas/qa-evidence-plan-v1.json',
  title: 'KB Labs expected QA evidence plan',
  type: 'object',
  required: ['schema', 'mode', 'candidateId', 'profile'],
  properties: {
    schema: { const: 'kb.qa-evidence-plan/v1' },
    mode: { enum: ['local', 'secured'] },
    candidateId: { type: 'string', minLength: 1 },
    profile: { type: 'object', minProperties: 1, additionalProperties: { type: 'string', minLength: 1 } },
  },
  additionalProperties: false,
} as const;

export const QA_CASE_EVIDENCE_RUN_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://kb-labs.dev/schemas/qa-case-run-v3.json',
  title: 'KB Labs QA case run evidence',
  type: 'object',
  required: ['schema', 'runId', 'mode', 'claims'],
  properties: {
    schema: { const: QA_CASE_EVIDENCE_RUN_SCHEMA },
    runId: { type: 'string', minLength: 1 },
    mode: { enum: ['local', 'secured'] },
    candidateId: { type: 'string', minLength: 1 },
    profile: { type: 'object', minProperties: 1, additionalProperties: { type: 'string', minLength: 1 } },
    selection: { type: 'array', items: { type: 'string', minLength: 1 } },
    claims: {
      type: 'array',
      items: {
        type: 'object',
        required: ['claimId', 'kind', 'status'],
        properties: {
          claimId: { type: 'string', pattern: '^(S|PC)-[0-9]{3}\\.[0-9]+$' },
          kind: { enum: ['journey', 'e2e', 'unit'] },
          status: { enum: ['PASS', 'FAIL'] },
          configRef: { type: 'string', minLength: 1 },
          configDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
          logRef: { type: 'string', minLength: 1 },
          logDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
} as const;

export type QACaseEvidenceStatus = 'COMPLETE' | 'INCOMPLETE';

export interface QACaseStepCoverage {
  stepId: string;
  status: QACaseStepResult;
  reason?: string;
  claims: QACaseClaim[];
}

export interface QACaseCoverage {
  schema: 'kb.qa-case-coverage/v1' | 'kb.qa-case-coverage/v2';
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

export interface QACaseEvidenceCoverage {
  schema: 'kb.qa-case-coverage/v2';
  mode: QACaseMode;
  cases: Array<{
    id: string;
    title: string;
    status: QACaseStatus;
    release: boolean;
    statusResult: 'PASS' | 'FAIL' | 'NOT RUN' | 'NOT COVERED' | 'NOT REQUIRED';
    reason?: string;
    steps: Array<QACaseStepCoverage & {
      evidenceStatus: QACaseEvidenceStatus;
      expectedCandidateId?: string;
      observedCandidateIds: string[];
      expectedProfile?: Record<string, string>;
      configRefs: QACaseEvidenceArtifactRef[];
      logRefs: QACaseEvidenceArtifactRef[];
    }>;
  }>;
  releasePassed: boolean;
  evidencePassed: boolean;
}

/** Versioned schema for evidence-backed `kb qa coverage show --json`. */
export const QA_CASE_EVIDENCE_COVERAGE_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://kb-labs.dev/schemas/qa-case-coverage-v2.json',
  title: 'KB Labs QA case coverage with evidence',
  type: 'object',
  required: ['schema', 'mode', 'cases', 'releasePassed', 'evidencePassed'],
  properties: {
    schema: { const: 'kb.qa-case-coverage/v2' },
    mode: { enum: ['local', 'secured'] },
    releasePassed: { type: 'boolean' },
    evidencePassed: { type: 'boolean' },
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
              required: ['stepId', 'status', 'claims', 'evidenceStatus'],
              properties: {
                stepId: { type: 'string', pattern: '^(S|PC)-[0-9]{3}\\.[0-9]+$' },
                status: { enum: ['PASS', 'FAIL', 'NOT RUN', 'NOT COVERED'] },
                evidenceStatus: { enum: ['COMPLETE', 'INCOMPLETE'] },
                reason: { type: 'string' },
                expectedCandidateId: { type: 'string' },
                observedCandidateIds: { type: 'array', items: { type: 'string' } },
                expectedProfile: { type: 'object', additionalProperties: { type: 'string' } },
                configRefs: { type: 'array', items: { $ref: '#/$defs/artifactRef' } },
                logRefs: { type: 'array', items: { $ref: '#/$defs/artifactRef' } },
                claims: { type: 'array' },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    },
  },
  $defs: {
    artifactRef: {
      type: 'object',
      required: ['runId', 'runRoot', 'path', 'sha256'],
      properties: {
        runId: { type: 'string' },
        runRoot: { type: 'string' },
        path: { type: 'string' },
        sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
} as const;

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
