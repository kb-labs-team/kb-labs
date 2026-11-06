/**
 * @module @kb-labs/core-platform/error-envelope/validate
 *
 * Dependency-free structural validator for {@link ErrorEnvelope}. It enforces
 * the same rules as `error-envelope.schema.json`; shared fixtures keep the Go
 * clikit boundary, TypeScript and Studio in sync.
 */

import { ERROR_AREAS, ERROR_SEVERITIES, ERROR_STAGES, ErrorEnvelopeJsonSchema, type ErrorEnvelope } from './types.js';

const CODE_PATTERN = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/;
const ENVELOPE_KEYS = Object.keys(ErrorEnvelopeJsonSchema.properties);
const FULL_ENVELOPE_REQUIRED_KEYS = ErrorEnvelopeJsonSchema.required.filter(
  (key) => key !== 'code' && key !== 'message' && key !== 'hint',
);
const ALLOWED_KEYS = new Set(ENVELOPE_KEYS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Identifies a possibly malformed envelope without claiming that it is valid. */
export function hasErrorEnvelopeIdentity(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  return FULL_ENVELOPE_REQUIRED_KEYS.some((key) => key in value);
}

export interface ErrorEnvelopeValidationIssue {
  field: string;
  reason: string;
}

/** Returns field-specific problems; empty means the value is a valid envelope. */
export function validateErrorEnvelope(value: unknown): ErrorEnvelopeValidationIssue[] {
  if (!isRecord(value)) {
    return [{ field: 'envelope', reason: 'must be an object' }];
  }
  const problems: ErrorEnvelopeValidationIssue[] = [];
  const add = (field: string, reason: string) => problems.push({ field, reason });
  for (const key of Object.keys(value)) {
    if (!ALLOWED_KEYS.has(key)) {
      add(key, 'is an unknown field');
    }
  }
  if (typeof value.code !== 'string' || !CODE_PATTERN.test(value.code)) {
    add('code', 'must match ^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$');
  }
  if (typeof value.area !== 'string' || !(ERROR_AREAS as readonly string[]).includes(value.area)) {
    add('area', `must be one of ${ERROR_AREAS.join(', ')}`);
  }
  if (typeof value.stage !== 'string' || !(ERROR_STAGES as readonly string[]).includes(value.stage)) {
    add('stage', `must be one of ${ERROR_STAGES.join(', ')}`);
  }
  if (
    typeof value.severity !== 'string' ||
    !(ERROR_SEVERITIES as readonly string[]).includes(value.severity)
  ) {
    add('severity', `must be one of ${ERROR_SEVERITIES.join(', ')}`);
  }
  if (typeof value.retryable !== 'boolean') {
    add('retryable', 'must be a boolean');
  }
  if (!nonEmptyString(value.message)) {
    add('message', 'must be a non-empty string');
  }
  if (!nonEmptyString(value.hint)) {
    add('hint', 'must be a non-empty string');
  }
  for (const key of ['cause', 'docs', 'correlationId'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'string') {
      add(key, 'must be a string');
    }
  }
  if (value.actions !== undefined) {
    if (!Array.isArray(value.actions)) {
      add('actions', 'must be an array');
    } else {
      value.actions.forEach((action: unknown, index: number) => {
        if (!isRecord(action) || !nonEmptyString(action.id) || !nonEmptyString(action.label)) {
          add(`actions[${index}]`, 'needs non-empty id and label');
          return;
        }
        for (const key of Object.keys(action)) {
          if (key !== 'id' && key !== 'label' && key !== 'command') {
            add(`actions[${index}].${key}`, 'is an unknown field');
          }
        }
        if (action.command !== undefined && typeof action.command !== 'string') {
          add(`actions[${index}].command`, 'must be a string');
        }
      });
    }
  }
  if (value.details !== undefined) {
    if (!isRecord(value.details)) {
      add('details', 'must be an object');
    } else {
      for (const [key, entry] of Object.entries(value.details)) {
        if (typeof entry === 'string' && isSerializedStructuredValue(entry)) {
          add(`details.${key}`, 'must not contain serialized JSON; use data or diagnostics');
        }
      }
    }
  }
  if (value.diagnostics !== undefined) {
    if (!Array.isArray(value.diagnostics)) {
      add('diagnostics', 'must be an array');
    } else {
      value.diagnostics.forEach((diagnostic: unknown, index: number) => {
        if (!isRecord(diagnostic) || !nonEmptyString(diagnostic.code) || !nonEmptyString(diagnostic.message) ||
          typeof diagnostic.severity !== 'string' || !(ERROR_SEVERITIES as readonly string[]).includes(diagnostic.severity)) {
          add(`diagnostics[${index}]`, 'needs code, message, and valid severity');
          return;
        }
        for (const key of Object.keys(diagnostic)) {
          if (!['code', 'message', 'severity', 'path', 'line', 'hint'].includes(key)) {
            add(`diagnostics[${index}].${key}`, 'is an unknown field');
          }
        }
        for (const key of ['path', 'hint'] as const) {
          if (diagnostic[key] !== undefined && typeof diagnostic[key] !== 'string') {
            add(`diagnostics[${index}].${key}`, 'must be a string');
          }
        }
        if (diagnostic.line !== undefined && (!Number.isInteger(diagnostic.line) || Number(diagnostic.line) < 1)) {
          add(`diagnostics[${index}].line`, 'must be a positive integer');
        }
      });
    }
  }
  return problems;
}

function isSerializedStructuredValue(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null;
  } catch {
    return false;
  }
}

export function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  return validateErrorEnvelope(value).length === 0;
}
