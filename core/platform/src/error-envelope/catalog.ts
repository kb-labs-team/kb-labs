/**
 * @module @kb-labs/core-platform/error-envelope/catalog
 *
 * Typed access to `errors.catalog.json` (the data source for platform error
 * codes) and the helper that builds an envelope from a catalog code.
 */

import catalogData from './errors.catalog.json';
import { redactProcessSensitiveString } from '../logging/context.js';
import { markValidatedErrorEnvelope, type ValidatedErrorEnvelope } from './validated-envelope.js';
import type {
  ErrorAction,
  ErrorCatalog,
  ErrorCatalogEntry,
  ErrorCode,
  PlatformErrorCode,
  ErrorEnvelope,
  PlatformDiagnostic,
} from './types.js';
import { catalogRequiredHintTemplateParameters, catalogRequiredMessageTemplateParameters, catalogStructuredDetailFields, catalogTemplateParameterNames } from './error-codes.generated.js';
import type { CatalogHintTemplateParameters, CatalogMessageTemplateParameters, CatalogRuntimeTemplateParameters, CatalogTemplateParameters } from './error-codes.generated.js';
import type { CatalogDetailsFor, CatalogErrorRequest } from './error-codes.generated.js';
export type { CatalogErrorRequest } from './error-codes.generated.js';

/** Catalogue-derived detail fields accepted by a bridge for a specific code. */
export type DetailsFor<C extends PlatformErrorCode> = C extends PlatformErrorCode ? CatalogDetailsFor[C] : never;

type RequiredDetailKeys<T> = { [K in keyof T]-?: Record<string, never> extends Pick<T, K> ? never : K }[keyof T];

/** Positional detail argument for typed bridges; required catalogue fields cannot be omitted. */
export type DetailsArgumentFor<C extends PlatformErrorCode> = [RequiredDetailKeys<DetailsFor<C>>] extends [never]
  ? [details?: DetailsFor<C>]
  : [details: DetailsFor<C>];

/** Object detail property for typed bridges; required catalogue fields cannot be omitted. */
export type DetailsOptionFor<C extends PlatformErrorCode> = [RequiredDetailKeys<DetailsFor<C>>] extends [never]
  ? { details?: DetailsFor<C> }
  : { details: DetailsFor<C> };

// The JSON is validated structurally by the catalog lint test; the cast keeps
// the literal union types (area, severity) that JSON inference widens to string.
export const errorCatalog = catalogData as unknown as ErrorCatalog;

const byCode = new Map<string, ErrorCatalogEntry>(
  errorCatalog.codes.map((entry) => [entry.code, entry]),
);

export function isErrorCode(code: string): code is PlatformErrorCode {
  return byCode.has(code);
}

export function getCatalogEntry(code: PlatformErrorCode): ErrorCatalogEntry {
  const entry = byCode.get(code);
  if (!entry) {
    throw new Error(`Catalogued error ${code} is missing from errors.catalog.json`);
  }
  return entry;
}

/** Map catalogued command failures to the CLI usage exit code at shared boundaries. */
export function mapErrorEnvelopeToExitCode(code: ErrorCode): number {
  return code === 'KB_RUNTIME_INPUT_INVALID' || code === 'KB_RUNTIME_UNKNOWN_COMMAND' ? 2 : 1;
}

/** Render contract evidence without depending on Node-only inspection APIs. */
export function describeContractValue(value: unknown): { observedType: string; observedValuePreview: string } {
  const observedType = value === null ? 'null'
    : Array.isArray(value) ? 'array'
      : value instanceof Error ? 'error'
        : typeof value;
  const visited = new WeakSet<object>();
  let rendered: string;
  try {
    rendered = renderContractValue(value, visited, 0);
  } catch (cause) {
    const causeType = cause instanceof Error ? cause.name : typeof cause;
    rendered = `[unrenderable ${observedType}; renderer threw ${causeType}]`;
  }
  return { observedType, observedValuePreview: redactProcessSensitiveString(rendered).slice(0, 256) };
}

function renderContractValue(value: unknown, visited: WeakSet<object>, depth: number): string {
  if (typeof value === 'string') {return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;}
  if (typeof value === 'undefined') {return 'undefined';}
  if (typeof value === 'bigint') {return `${value}n`;}
  if (typeof value === 'symbol') {return value.toString();}
  if (typeof value === 'function') {return `[Function ${value.name || 'anonymous'}]`;}
  if (typeof value !== 'object' || value === null) {return String(value);}
  if (value instanceof Error) {return `${value.name}(${renderContractValue(value.message, visited, depth + 1)})`;}
  if (visited.has(value)) {return '[Circular]';}
  if (depth >= 3) {return Array.isArray(value) ? '[…]' : '{…}';}
  visited.add(value);
  if (Array.isArray(value)) {
    return `[${value.slice(0, 8).map((item) => renderContractValue(item, visited, depth + 1)).join(', ')}${value.length > 8 ? ', …' : ''}]`;
  }
  const entries = Object.entries(value).slice(0, 8);
  return `{ ${entries.map(([key, item]) => `${key}: ${renderContractValue(item, visited, depth + 1)}`).join(', ')}${Object.keys(value).length > 8 ? ', …' : ''} }`;
}

/** Substitutes only catalogue-declared names; all other brace text remains literal. */
export function renderTemplate(
  template: string,
  values: Readonly<Record<string, string>> = {},
  declaredNames: readonly string[] = [],
): string {
  const declared = new Set(declaredNames);
  let rendered = '';
  let remaining = template;
  while (remaining.length > 0) {
    const opening = remaining.indexOf('{');
    if (opening < 0) {return rendered + remaining;}
    rendered += remaining.slice(0, opening);
    const closing = remaining.indexOf('}', opening + 1);
    if (closing < 0) {return rendered + remaining.slice(opening);}
    const name = remaining.slice(opening + 1, closing);
    const literal = remaining.slice(opening, closing + 1);
    rendered += declared.has(name) && values[name] !== undefined ? values[name] : literal;
    remaining = remaining.slice(closing + 1);
  }
  return rendered;
}

type DataTemplateParameters<C extends PlatformErrorCode> = CatalogTemplateParameters[C];
type RuntimeTemplateParameters<C extends PlatformErrorCode> = CatalogRuntimeTemplateParameters[C];
type MessageTemplateParameters<C extends PlatformErrorCode> = CatalogMessageTemplateParameters[C];
type HintTemplateParameters<C extends PlatformErrorCode> = CatalogHintTemplateParameters[C];
type RequiredDataParameters<C extends PlatformErrorCode, O extends EnvelopeOptionFields> =
  (O extends { message: string } ? Record<never, never> : MessageTemplateParameters<C>)
  & (O extends { hint: string } ? Record<never, never> : HintTemplateParameters<C>);
type RequiredHintRuntimeParameters<C extends PlatformErrorCode, O extends EnvelopeOptionFields> =
  O extends { hint: string } ? Record<never, never> : RuntimeTemplateParameters<C>;
type TemplateValueOption<C extends PlatformErrorCode, O extends EnvelopeOptionFields> =
  [RequiredDetailKeys<RequiredHintRuntimeParameters<C, O>>] extends [never]
    ? { templateValues?: RuntimeTemplateParameters<C> }
    : { templateValues: RuntimeTemplateParameters<C> };
type EnvelopeDetailsFor<C extends PlatformErrorCode, O extends EnvelopeOptionFields> =
  Omit<DetailsFor<C>, keyof DataTemplateParameters<C>> & RequiredDataParameters<C, O>;
type DetailsOption<C extends PlatformErrorCode, O extends EnvelopeOptionFields> =
  [keyof RequiredDataParameters<C, O>] extends [never]
    ? { details?: EnvelopeDetailsFor<C, O> }
    : { details: EnvelopeDetailsFor<C, O> };
type CreateEnvelopeOptionsFor<C extends PlatformErrorCode, O extends EnvelopeOptionFields> =
  O & DetailsOption<C, O> & TemplateValueOption<C, O>;

export type CreateEnvelopeOptions<C extends PlatformErrorCode = never> = EnvelopeOptionFields
  & DetailsOption<C, EnvelopeOptionFields>
  & TemplateValueOption<C, EnvelopeOptionFields>;

interface EnvelopeOptionFields {
  /** Structured details and invocation-owned template values must be secret-free. */
  cause?: string;
  correlationId?: string;
  actions?: ErrorAction[];
  docs?: string;
  /** Override a catalog hint when a typed error carries a more specific next step. */
  hint?: string;
  /** Override a catalog message when a typed error carries a more specific explanation. */
  message?: string;
  diagnostics?: PlatformDiagnostic[];
  severity?: ErrorEnvelope['severity'];
}

type EnvelopeOptionsArgs<C extends PlatformErrorCode, O extends EnvelopeOptionFields> = [keyof RequiredDataParameters<C, O>] extends [never]
  ? [RequiredDetailKeys<RequiredHintRuntimeParameters<C, O>>] extends [never] ? [options?: CreateEnvelopeOptionsFor<C, O>] : [options: CreateEnvelopeOptionsFor<C, O>]
  : [options: CreateEnvelopeOptionsFor<C, O>];

/** Builds an envelope from a catalog code. Throws for missing template values or an unknown code. */
export function createErrorEnvelope<C extends PlatformErrorCode, O extends EnvelopeOptionFields = EnvelopeOptionFields>(code: C, ...args: EnvelopeOptionsArgs<C, O>): ValidatedErrorEnvelope;
export function createErrorEnvelope(code: PlatformErrorCode, options: EnvelopeOptionFields & { details?: unknown; templateValues?: unknown } = {}): ValidatedErrorEnvelope {
  return buildErrorEnvelope(code, options);
}

/** Constructs an internal producer diagnostic from a catalog-generated request. */
export function createCatalogErrorEnvelope(request: CatalogErrorRequest): ValidatedErrorEnvelope {
  return buildErrorEnvelope(request.code, request);
}

/** Validates an error received across an untrusted execution or serialization boundary. */
export function createUntrustedErrorEnvelope(
  code: unknown,
  options: EnvelopeOptionFields & { details?: unknown; templateValues?: unknown } = {},
): ValidatedErrorEnvelope {
  if (typeof code !== 'string' || !isErrorCode(code)) {
    return createErrorEnvelope('KB_RUNTIME_UNEXPECTED');
  }
  return buildErrorEnvelope(code, options);
}

function toDetailMap(value: unknown): Record<string, unknown> | undefined | null {
  if (value === undefined) {return undefined;}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {return null;}
  return { ...value };
}

function toStringMap(value: unknown): Record<string, string> | undefined | null {
  if (value === undefined) {return undefined;}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {return null;}
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') {return null;}
    result[key] = item;
  }
  return result;
}

function matchesCatalogSchema(value: unknown, schema: { type: string; [key: string]: unknown }): boolean {
  if (schema.type === 'string') {return typeof value === 'string';}
  if (schema.type === 'array') {return Array.isArray(value) && value.every((item) => matchesCatalogSchema(item, schema.items as { type: string; [key: string]: unknown }));}
  if (schema.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {return false;}
    const record = value as Record<string, unknown>;
    const properties = schema.properties as Record<string, { type: string; [key: string]: unknown }>;
    const required = schema.required as string[] ?? [];
    if (required.some((name) => !(name in record))) {return false;}
    if (schema.additionalProperties === false && Object.keys(record).some((name) => !(name in properties))) {return false;}
    return Object.entries(record).every(([name, item]) => properties[name] !== undefined && matchesCatalogSchema(item, properties[name]!));
  }
  return false;
}

function buildErrorEnvelope(code: PlatformErrorCode, options: EnvelopeOptionFields & { details?: unknown; templateValues?: unknown }): ValidatedErrorEnvelope {
  const entry = byCode.get(code);
  if (!entry) {
    throw new Error(`Unknown error code "${code}": add it to errors.catalog.json`);
  }
  const parsedDetails = toDetailMap(options.details);
  const parsedTemplateValues = toStringMap(options.templateValues);
  if (parsedDetails === null || parsedTemplateValues === null) {
    throw createErrorDetailsContractViolation('details', 'must be a flat map of string identifiers', options.details);
  }
  const details = parsedDetails ?? {};
  const templateValuesInput = parsedTemplateValues ?? {};
  const parameterNames = catalogTemplateParameterNames[code];
  const allowedDetails = new Set([...parameterNames, ...catalogStructuredDetailFields[code]]);
  const templateValues: Record<string, string> = {
    ...Object.fromEntries(Object.entries(details).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
    ...templateValuesInput,
    ...(options.correlationId ? { correlationId: options.correlationId } : {}),
  };
  const structuredFields = new Set(catalogStructuredDetailFields[code]);
  for (const [key, value] of Object.entries(details)) {
    const schema = entry.structuredDetailSchemas?.[key];
    if (typeof value === 'string' && isSerializedStructuredValue(value)) {
      throw createErrorDetailsContractViolation(key, 'contains serialized JSON', value);
    }
    if (typeof value !== 'string' && (!structuredFields.has(key) || schema === undefined || !matchesCatalogSchema(value, schema))) {
      throw createErrorDetailsContractViolation(key, 'must be a string identifier or match its catalogued structured schema', value);
    }
  }
  const violationFields = [
    ...Object.keys(details).filter((key) => !allowedDetails.has(key)),
    ...Object.entries(details).filter(([key, value]) => {
      const schema = entry.structuredDetailSchemas?.[key];
      return (parameterNames.includes(key) && typeof value !== 'string')
        || (typeof value !== 'string' && (!structuredFields.has(key) || schema === undefined))
        || (schema !== undefined && !matchesCatalogSchema(value, schema));
    }).map(([key]) => key),
    ...Object.keys(templateValuesInput).filter((key) => !parameterNames.includes(key)),
  ];
  const requiredParameters = [
    ...(!options.message ? catalogRequiredMessageTemplateParameters[code] : []),
    ...(!options.hint ? catalogRequiredHintTemplateParameters[code] : []),
  ];
  for (const name of requiredParameters) {
    if (templateValues[name] === undefined || templateValues[name].trim() === '') {violationFields.push(name);}
  }
  for (const name of entry.requiredStructuredDetailFields ?? []) {
    if (!Object.hasOwn(details, name)) {violationFields.push(name);}
  }
  if (violationFields.length > 0) {
    const field = [...new Set(violationFields)].sort()[0]!;
    const observed = Object.hasOwn(details, field) ? details[field]
      : Object.hasOwn(templateValuesInput, field) ? templateValuesInput[field]
        : undefined;
    return createDiagnosticContractViolation(code, [...new Set(violationFields)].sort(), field, observed);
  }
  const envelope: ErrorEnvelope = {
    code: entry.code,
    area: entry.area,
    stage: entry.stage,
    severity: options.severity ?? entry.severity,
    retryable: entry.retryable,
    message: options.message ?? renderTemplate(entry.message, templateValues, parameterNames),
    hint: options.hint ?? renderTemplate(
      !options.correlationId && entry.hintWithoutCorrelationId ? entry.hintWithoutCorrelationId : entry.hint,
      templateValues,
      parameterNames,
    ),
  };
  if (options.cause && options.cause !== envelope.message) {
    envelope.cause = options.cause;
  }
  if (options.actions && options.actions.length > 0) {
    envelope.actions = options.actions;
  }
  if (options.docs) {
    envelope.docs = options.docs;
  }
  if (options.correlationId) {
    envelope.correlationId = options.correlationId;
  }
  if (Object.keys(details).length > 0) {
    envelope.details = details;
  }
  if (options.diagnostics?.length) {
    envelope.diagnostics = options.diagnostics;
  }
  return markValidatedErrorEnvelope(envelope);
}

function createDiagnosticContractViolation(originalCode: string, fields: readonly string[], field: string, observedValue: unknown): ValidatedErrorEnvelope {
  const evidence = describeContractValue(observedValue);
  return createErrorEnvelope('KB_RUNTIME_DIAGNOSTIC_CONTRACT_VIOLATION', {
    details: { originalCode, fields: fields.join(', '), field, ...evidence },
  });
}

export function isSerializedStructuredValue(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null;
  } catch {
    return false;
  }
}

export function createErrorDetailsContractViolation(key: string, reason: string, observedValue?: unknown): Error & { code: string; hint: string; field: string; observedType: string; observedValuePreview: string } {
  const evidence = describeContractValue(observedValue);
  return Object.assign(new Error(`Error detail "${key}" ${reason}; use result data or error.diagnostics.`), {
    code: 'KB_PLUGIN_CONTRACT_VIOLATION',
    hint: 'Keep error.details values as identifiers; return structured reports in data or gate findings in error.diagnostics.',
    field: key,
    ...evidence,
  });
}
