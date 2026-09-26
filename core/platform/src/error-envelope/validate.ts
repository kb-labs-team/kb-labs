/**
 * @module @kb-labs/core-platform/error-envelope/validate
 *
 * Dependency-free structural validator for {@link ErrorEnvelope}. It enforces
 * the same rules as `error-envelope.schema.json` and as `LauncherError.Validate`
 * on the Go side; the shared fixtures keep the three in sync.
 */

import { ERROR_AREAS, ERROR_SEVERITIES, ERROR_STAGES, type ErrorEnvelope } from './types.js';

const CODE_PATTERN = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/;
const ALLOWED_KEYS = new Set([
  'code',
  'area',
  'stage',
  'severity',
  'retryable',
  'message',
  'cause',
  'hint',
  'actions',
  'docs',
  'correlationId',
  'details',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Returns a list of problems; empty means the value is a valid envelope. */
export function validateErrorEnvelope(value: unknown): string[] {
  if (!isRecord(value)) {
    return ['envelope must be an object'];
  }
  const problems: string[] = [];
  for (const key of Object.keys(value)) {
    if (!ALLOWED_KEYS.has(key)) {
      problems.push(`unknown field "${key}"`);
    }
  }
  if (typeof value.code !== 'string' || !CODE_PATTERN.test(value.code)) {
    problems.push('code must match ^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$');
  }
  if (typeof value.area !== 'string' || !(ERROR_AREAS as readonly string[]).includes(value.area)) {
    problems.push(`area must be one of ${ERROR_AREAS.join(', ')}`);
  }
  if (typeof value.stage !== 'string' || !(ERROR_STAGES as readonly string[]).includes(value.stage)) {
    problems.push(`stage must be one of ${ERROR_STAGES.join(', ')}`);
  }
  if (
    typeof value.severity !== 'string' ||
    !(ERROR_SEVERITIES as readonly string[]).includes(value.severity)
  ) {
    problems.push(`severity must be one of ${ERROR_SEVERITIES.join(', ')}`);
  }
  if (typeof value.retryable !== 'boolean') {
    problems.push('retryable must be a boolean');
  }
  if (!nonEmptyString(value.message)) {
    problems.push('message must be a non-empty string');
  }
  if (!nonEmptyString(value.hint)) {
    problems.push('hint must be a non-empty string');
  }
  for (const key of ['cause', 'docs', 'correlationId'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'string') {
      problems.push(`${key} must be a string`);
    }
  }
  if (value.actions !== undefined) {
    if (!Array.isArray(value.actions)) {
      problems.push('actions must be an array');
    } else {
      value.actions.forEach((action: unknown, index: number) => {
        if (!isRecord(action) || !nonEmptyString(action.id) || !nonEmptyString(action.label)) {
          problems.push(`actions[${index}] needs non-empty id and label`);
          return;
        }
        for (const key of Object.keys(action)) {
          if (key !== 'id' && key !== 'label' && key !== 'command') {
            problems.push(`actions[${index}] has unknown field "${key}"`);
          }
        }
        if (action.command !== undefined && typeof action.command !== 'string') {
          problems.push(`actions[${index}].command must be a string`);
        }
      });
    }
  }
  if (value.details !== undefined) {
    if (!isRecord(value.details)) {
      problems.push('details must be an object');
    } else if (Object.values(value.details).some((entry) => typeof entry !== 'string')) {
      problems.push('details values must be strings');
    }
  }
  return problems;
}

export function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  return validateErrorEnvelope(value).length === 0;
}
