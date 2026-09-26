/**
 * @module @kb-labs/core-platform/error-envelope/types
 *
 * The unified error envelope shared by the Go launcher (`LauncherError`),
 * the TS platform and Studio. Mirrors `error-envelope.schema.json`.
 * See docs/architecture/target/08-errors.md section 2 and ADR-0033.
 */

export const ERROR_AREAS = [
  'install',
  'host',
  'auth',
  'project',
  'config',
  'plugin',
  'update',
  'runtime',
  'product',
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

export interface ErrorEnvelope {
  /** Stable, never reused: `KB_<AREA>_<CONDITION>` or `<PLUGIN>_<CONDITION>`. */
  code: string;
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
  details?: Record<string, string>;
}

/** One row of `errors.catalog.json`. */
export interface ErrorCatalogEntry {
  code: string;
  area: ErrorArea;
  stage: ErrorStage;
  severity: ErrorSeverity;
  retryable: boolean;
  /** Template; `{name}` placeholders are filled from `details`. */
  message: string;
  /** Template; `{name}` placeholders are filled from `details`. */
  hint: string;
  deprecated?: boolean;
}

export interface ErrorCatalog {
  version: 1;
  codes: ErrorCatalogEntry[];
}
