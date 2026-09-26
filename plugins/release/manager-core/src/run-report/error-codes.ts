/**
 * KB_RELEASE_* error codes — single source of truth for release-stage failures.
 *
 * Stages and codes follow docs/architecture/target/09-release-process.md §3.1.
 * The descriptor field names deliberately mirror the shared error envelope from
 * docs/architecture/target/08-errors.md §2 (code, area, stage, severity,
 * retryable, message, cause, hint, actions, docs, correlationId, details) so a
 * later change can swap these local types for the shared contract without
 * touching call sites.
 *
 * FOLLOW-UP: the shared envelope is being built in a separate branch. When it
 * lands, replace `ReleaseErrorEnvelope` / `ReleaseErrorAction` below with the
 * shared types and keep only the code catalog here.
 *
 * Codes are a stable API: never reuse or change the meaning of one.
 */

/** Release stages from 09 §3.1 that can fail with a code. */
export type ReleaseErrorStage =
  | 'preflight'
  | 'plan'
  | 'stage'
  | 'checks'
  | 'prepare'
  | 'git'
  | 'candidate'
  | 'deliver'
  | 'smoke'
  | 'promote';

export const KB_RELEASE_CODES = [
  // preflight
  'KB_RELEASE_BRANCH_NOT_MASTER',
  'KB_RELEASE_TREE_DIRTY',
  'KB_RELEASE_DOCKER_UNAVAILABLE',
  'KB_RELEASE_REGISTRY_UNREACHABLE',
  'KB_RELEASE_TOKEN_MISSING',
  'KB_RELEASE_BASELINE_DRIFT',
  // plan
  'KB_RELEASE_PLAN_INVALID',
  // stage
  'KB_RELEASE_STAGING_FAILED',
  // checks
  'KB_RELEASE_CHECK_FAILED',
  'KB_RELEASE_CHECK_TIMEOUT',
  // prepare / git
  'KB_RELEASE_GIT_PUSH_REJECTED',
  // candidate (CI)
  'KB_RELEASE_INDEX_SEAL_FAILED',
  'KB_RELEASE_BUILD_FAILED',
  // deliver (CI)
  'KB_RELEASE_REGISTRY_BINDING_FAILED',
  // smoke (CI)
  'KB_RELEASE_SMOKE_FAILED',
  // promote
  'KB_RELEASE_PROMOTE_FAILED',
] as const;

export type ReleaseErrorCode = (typeof KB_RELEASE_CODES)[number];

export interface ReleaseErrorAction {
  id: string;
  label: string;
  /** Copy-paste-ready command. */
  command?: string;
}

/** Envelope-compatible error shape (08-errors.md §2), area fixed to `release`. */
export interface ReleaseErrorEnvelope {
  code: ReleaseErrorCode;
  area: 'release';
  stage: ReleaseErrorStage;
  severity: 'error' | 'warning';
  retryable: boolean;
  message: string;
  /** Why it happened, one line, no secrets. */
  cause?: string;
  /** What to do now. */
  hint?: string;
  actions?: ReleaseErrorAction[];
  docs?: string;
  correlationId?: string;
  details?: Record<string, string>;
}

interface CodeSpec {
  stage: ReleaseErrorStage;
  retryable: boolean;
  message: string;
}

const CATALOG: Record<ReleaseErrorCode, CodeSpec> = {
  KB_RELEASE_BRANCH_NOT_MASTER: { stage: 'preflight', retryable: false, message: 'Release must be started from the master branch.' },
  KB_RELEASE_TREE_DIRTY: { stage: 'preflight', retryable: false, message: 'Working tree has uncommitted changes.' },
  KB_RELEASE_DOCKER_UNAVAILABLE: { stage: 'preflight', retryable: true, message: 'Docker is not available.' },
  KB_RELEASE_REGISTRY_UNREACHABLE: { stage: 'preflight', retryable: true, message: 'The release registry is unreachable.' },
  KB_RELEASE_TOKEN_MISSING: { stage: 'preflight', retryable: false, message: 'A required registry or GitHub token is missing.' },
  KB_RELEASE_BASELINE_DRIFT: { stage: 'preflight', retryable: false, message: 'Stable tag and npm baseline have diverged.' },
  KB_RELEASE_PLAN_INVALID: { stage: 'plan', retryable: false, message: 'The release plan is invalid.' },
  KB_RELEASE_STAGING_FAILED: { stage: 'stage', retryable: true, message: 'Staging the planned versions failed.' },
  KB_RELEASE_CHECK_FAILED: { stage: 'checks', retryable: false, message: 'A release check failed.' },
  KB_RELEASE_CHECK_TIMEOUT: { stage: 'checks', retryable: true, message: 'A release check timed out.' },
  KB_RELEASE_GIT_PUSH_REJECTED: { stage: 'git', retryable: false, message: 'Git push was rejected.' },
  KB_RELEASE_INDEX_SEAL_FAILED: { stage: 'candidate', retryable: false, message: 'Sealing the release index failed.' },
  KB_RELEASE_BUILD_FAILED: { stage: 'candidate', retryable: false, message: 'Building the release candidate failed.' },
  KB_RELEASE_REGISTRY_BINDING_FAILED: { stage: 'deliver', retryable: true, message: 'Binding delivered bytes to the registry failed.' },
  KB_RELEASE_SMOKE_FAILED: { stage: 'smoke', retryable: true, message: 'Smoke install of the public candidate failed.' },
  KB_RELEASE_PROMOTE_FAILED: { stage: 'promote', retryable: true, message: 'Promoting the candidate to a channel failed.' },
};

export function describeReleaseError(code: ReleaseErrorCode): Readonly<CodeSpec> {
  return CATALOG[code];
}

export interface CreateReleaseErrorInput {
  code: ReleaseErrorCode;
  /** Overrides the catalog message. */
  message?: string;
  cause?: string;
  hint?: string;
  actions?: ReleaseErrorAction[];
  severity?: 'error' | 'warning';
  retryable?: boolean;
  correlationId?: string;
  details?: Record<string, string>;
}

/** Build an envelope-shaped release error from the catalog defaults. */
export function createReleaseError(input: CreateReleaseErrorInput): ReleaseErrorEnvelope {
  const spec = CATALOG[input.code];
  const out: ReleaseErrorEnvelope = {
    code: input.code,
    area: 'release',
    stage: spec.stage,
    severity: input.severity ?? 'error',
    retryable: input.retryable ?? spec.retryable,
    message: input.message ?? spec.message,
  };
  if (input.cause !== undefined) { out.cause = input.cause; }
  if (input.hint !== undefined) { out.hint = input.hint; }
  if (input.actions !== undefined) { out.actions = input.actions; }
  if (input.correlationId !== undefined) { out.correlationId = input.correlationId; }
  if (input.details !== undefined) { out.details = input.details; }
  return out;
}
