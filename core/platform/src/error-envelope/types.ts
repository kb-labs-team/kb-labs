/**
 * @module @kb-labs/core-platform/error-envelope/types
 *
 * The unified error envelope shared by Go CLIs through clikit, the TS platform,
 * and Studio. Mirrors `error-envelope.schema.json`.
 * See docs/architecture/target/08-errors.md section 2 and ADR-0033.
 */

import type { CatalogErrorCode } from './error-codes.generated.js';

export type PlatformErrorCode = CatalogErrorCode;
declare const productErrorCodeBrand: unique symbol;
/** A product code validated against the ADR-0049 `<PLUGIN>_<CONDITION>` contract. */
export type ProductErrorCode = string & { readonly [productErrorCodeBrand]: true };
export type ErrorCode = PlatformErrorCode | ProductErrorCode;


export const ERROR_AREAS = [
  'install',
  'host',
  'auth',
  'project',
  'config',
  'plugin',
  'toolchain',
  'update',
  'runtime',
  'product',
  'release',
] as const;
export type ErrorArea = (typeof ERROR_AREAS)[number];

/** Journey moments (02-ux-journey); mirrors the `stage` enum in error-envelope.schema.json. */
export const ERROR_STAGES = [
  'preflight',
  'resolve',
  'apply',
  'verify',
  'recover',
  'start',
  'login',
  'add-project',
  'run',
  'extend',
  'update',
  'rollback',
] as const;
export type ErrorStage = (typeof ERROR_STAGES)[number];

export const ERROR_SEVERITIES = ['error', 'warning'] as const;
export type ErrorSeverity = (typeof ERROR_SEVERITIES)[number];

export interface ErrorAction {
  id: string;
  label: string;
  /** Copy-ready command. */
  command?: string;
}

export interface PlatformDiagnostic {
  code: string;
  message: string;
  severity: ErrorSeverity;
  path?: string;
  line?: number;
  hint?: string;
}

export interface ErrorEnvelope {
  /** Stable, never reused: `KB_<AREA>_<CONDITION>` or `<PLUGIN>_<CONDITION>`. */
  code: ErrorCode;
  area: ErrorArea;
  /** Moment of the user journey. */
  stage: ErrorStage;
  severity: ErrorSeverity;
  retryable: boolean;
  /** What happened, in plain language. */
  message: string;
  /** Why it happened. Never contains secrets. */
  cause?: string;
  /** What to do now. */
  hint: string;
  actions?: ErrorAction[];
  docs?: string;
  /** Finds the record in the logs. */
  correlationId?: string;
  /** Structured, secret-free values. */
  details?: Record<string, unknown>;
  /** Structured findings produced by gate commands. */
  diagnostics?: PlatformDiagnostic[];
}


/** Thrown to propagate a catalogued envelope through a typed runtime boundary. */
export class ErrorEnvelopeError extends Error {
  constructor(public readonly envelope: ErrorEnvelope) {
    super(envelope.message);
    this.name = 'ErrorEnvelopeError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** JSON Schema form used by Fastify response validators and serializers. */
export const ErrorEnvelopeJsonSchema = {
  type: 'object',
  properties: {
    code: { type: 'string', pattern: '^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$' },
    area: { enum: ERROR_AREAS },
    stage: { enum: ERROR_STAGES },
    severity: { enum: ERROR_SEVERITIES },
    retryable: { type: 'boolean' },
    message: { type: 'string', minLength: 1 },
    cause: { type: 'string' },
    hint: { type: 'string', minLength: 1 },
    actions: { type: 'array', items: { type: 'object', properties: { id: { type: 'string', minLength: 1 }, label: { type: 'string', minLength: 1 }, command: { type: 'string' } }, required: ['id', 'label'], additionalProperties: false } },
    docs: { type: 'string' },
    correlationId: { type: 'string' },
    details: { type: 'object', additionalProperties: true },
    diagnostics: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          code: { type: 'string', minLength: 1 },
          message: { type: 'string', minLength: 1 },
          severity: { enum: ERROR_SEVERITIES },
          path: { type: 'string' },
          line: { type: 'integer', minimum: 1 },
          hint: { type: 'string', minLength: 1 },
        },
        required: ['code', 'message', 'severity'],
        additionalProperties: false,
      },
    },
  },
  required: ['code', 'area', 'stage', 'severity', 'retryable', 'message', 'hint'],
  additionalProperties: false,
} as const;

/** Shared failure result schema returned by HTTP and machine boundaries. */
export const UxFailureResultJsonSchema = {
  type: 'object',
  properties: { ok: { const: false }, error: ErrorEnvelopeJsonSchema },
  required: ['ok', 'error'],
  additionalProperties: false,
} as const;

/** One row of `errors.catalog.json`. */
export interface ErrorCatalogEntry {
  code: PlatformErrorCode;
  /** Canonical HTTP status for this error code. */
  httpStatus: number;
  area: ErrorArea;
  stage: ErrorStage;
  severity: ErrorSeverity;
  retryable: boolean;
  /** Canonical Go CLI process-exit class; TS CLI mapping remains owned separately. */
  processExitClass: 'input-refusal' | 'operation-failure';
  /** Template; `{name}` placeholders are filled from `details`. */
  message: string;
  /** Template; `{name}` placeholders are filled from `details`. */
  hint: string;
  /** Hint used when the error has no correlation ID to fill its normal hint. */
  hintWithoutCorrelationId?: string;
  runtimeTemplateParameters?: Record<string, 'required' | 'optional'>;
  structuredDetailFields?: string[];
  requiredStructuredDetailFields?: string[];
  structuredDetailSchemas?: Record<string, { type: string; [key: string]: unknown }>;
  deprecated?: boolean;
}

export interface ErrorCatalog {
  version: 1;
  environmentVariables: string[];
  codes: ErrorCatalogEntry[];
}
