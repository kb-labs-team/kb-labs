/**
 * @module @kb-labs/core-platform/error-envelope/from-error
 *
 * Adapter from platform errors and structurally typed higher-layer errors to
 * the unified envelope. Core accepts the shared error shape without importing
 * command-kit or plugin-contracts.
 */

import { AdapterConfigError, AdapterCredentialsMissingError, AdapterOperationError, AdapterProjectScopeError, AdapterUnavailableError, getAdapterConfigurationCommand, PlatformConfigError, PlatformLayoutContractError, ServicePortConfigError, type TypedPlatformError } from '../errors.js';
import { HostServiceAddressError } from '../host-service-address.js';
import { createErrorDetailsContractViolation, createErrorEnvelope, createUntrustedErrorEnvelope, describeContractValue, getCatalogEntry, isErrorCode, isSerializedStructuredValue, type CreateEnvelopeOptions } from './catalog.js';
import { ErrorEnvelopeError, type ErrorEnvelope, type ProductErrorCode } from './types.js';
import { markValidatedErrorEnvelope, type ValidatedErrorEnvelope } from './validated-envelope.js';
import { isErrorEnvelope, validateErrorEnvelope } from './validate.js';

export type ToEnvelopeOptions = Pick<CreateEnvelopeOptions<never>, 'correlationId' | 'actions' | 'docs' | 'diagnostics'> & { binary?: string };
export type DecodeEnvelopeOptions = ToEnvelopeOptions & {
  protocolDetails?: Readonly<Record<string, string>>;
  presentation?: 'catalog' | 'handler';
};

/** Read a validated platform envelope carried by a typed error wrapper. */
export function errorEnvelopeFrom(error: unknown): ErrorEnvelope | undefined {
  if (error instanceof ErrorEnvelopeError) return error.envelope;
  if (typeof error !== 'object' || error === null) return undefined;
  if (!('envelope' in error)) return undefined;
  return isErrorEnvelope(error.envelope) ? error.envelope : undefined;
}

/** Convert any thrown value to an envelope. Unknown values become `KB_RUNTIME_UNEXPECTED`. */
export function toErrorEnvelope(error: unknown, options: ToEnvelopeOptions = {}): ValidatedErrorEnvelope {
  const typedEnvelope = errorEnvelopeFrom(error);
  if (typedEnvelope) return canonicalizeErrorEnvelope(typedEnvelope, options);
  const candidate = getErrorRecord(error);
  if (isErrorEnvelope(candidate)) {
    return canonicalizeErrorEnvelope(candidate, options);
  }
  if (error instanceof AdapterConfigError) {
    return createErrorEnvelope('KB_CONFIG_INVALID', {
      ...options,
      details: { path: error.optionPath },
      cause: error.detail,
      message: error.message,
      hint: error.hint,
    });
  }
  if (error instanceof ServicePortConfigError) {
    return createErrorEnvelope('KB_CONFIG_INVALID', {
      ...options,
      details: { path: error.envVar },
      cause: error.message,
      message: error.message,
      hint: `Run "unset ${error.envVar}", then retry the command to use the service default port.`,
    });
  }
  if (error instanceof HostServiceAddressError) {
    return createErrorEnvelope(
      error.reason === 'missing' ? 'KB_HOST_SERVICE_ADDRESS_MISSING' : 'KB_HOST_SERVICE_ADDRESS_INVALID',
      {
        ...options,
        cause: error.message,
        details: { service: error.service },
        hint: error.hint,
      },
    );
  }
  if (error instanceof PlatformConfigError) {
    const message = error.reason === 'read'
      ? `Platform configuration file "${error.configPath}" cannot be read.`
      : error.reason === 'parse'
        ? `Platform configuration file "${error.configPath}" contains invalid JSON.`
        : `Platform configuration file "${error.configPath}" is invalid.`;
    const hint = error.reason === 'parse'
      ? `Run python3 -m json.tool "${error.configPath}" to locate the syntax error, fix the file, then retry the CLI command.`
      : error.reason === 'read'
        ? `Run ls -l "${error.configPath}" to inspect the file and permissions, correct the issue, then retry the CLI command.`
        : `Run sed -n '1,200p' "${error.configPath}" to inspect the invalid settings, correct the reported issue, then retry the CLI command.`;
    return createErrorEnvelope('KB_CONFIG_INVALID', {
      ...options,
      details: { path: error.configPath },
      cause: error.detail,
      message,
      hint,
    });
  }
  if (error instanceof PlatformLayoutContractError) {
    return createErrorEnvelope('KB_CONFIG_INVALID', {
      ...options,
      details: {
        path: error.contractPath,
        contractPath: error.contractPath,
        remedyOperation: error.remedy.operation,
        remedyPlatformRoot: error.remedy.platformRoot,
      },
      message: error.message,
      hint: `Run \`kb-create ${error.remedy.operation} --platform-root ${JSON.stringify(error.remedy.platformRoot)}\` to restore it, then retry the command.`,
    });
  }
  if (error instanceof AdapterProjectScopeError) {
    return createErrorEnvelope('KB_ADAPTER_PROJECT_SCOPE', {
      ...options,
      details: { path: 'platform.adapters / platform.adapterOptions' },
      cause: error.message,
    });
  }
  if (error instanceof AdapterCredentialsMissingError) {
    const envReference = '${' + error.credential + '}';
    const command = `kb config set --scope platform ${error.configurationPath} '${envReference}' --allow-missing-env`;
    return createErrorEnvelope('KB_ADAPTER_CREDENTIALS_MISSING', {
      ...options,
      cause: error.message,
      details: {
        service: error.slot,
        credential: error.credential,
        path: error.configurationPath,
        command,
      },
      actions: [{ id: 'configure-adapter-credential', label: 'Configure adapter credential', command }],
    });
  }
  if (error instanceof AdapterUnavailableError) {
    if (error.reason === 'load-failed') {
      return createErrorEnvelope('KB_HOST_ADAPTER_UNAVAILABLE', {
        ...options,
        cause: error.message,
        details: { slot: error.slot, reason: error.reason },
        ...(error.hint ? { hint: error.hint } : {}),
        ...(error.userMessage ? { message: error.userMessage } : {}),
        ...(error.action ? { actions: [error.action] } : {}),
      });
    }
    const command = getAdapterConfigurationCommand(error.slot);
    return createErrorEnvelope('KB_ADAPTER_NOT_CONFIGURED', {
      ...options,
      cause: error.message,
      details: { service: error.slot, adapter: `platform.adapters.${error.slot}`, command },
      actions: [{
        id: 'configure-adapter',
        label: `Configure ${error.slot}`,
        command,
      }],
    });
  }
  if (error instanceof AdapterOperationError) {
    return createErrorEnvelope('KB_ADAPTER_OPERATION_FAILED', {
      ...options,
      cause: error.message,
      details: { slot: error.slot, operation: error.operation },
      hint: `Run "kb logs query" to inspect the ${error.slot} adapter failure, correct the underlying issue, then retry the operation.`,
    });
  }
  const source = getErrorRecord(error);
  if (source && (Array.isArray(source.validation) || Array.isArray(source.issues))) {
    const validationDetails = getDetails(source.details);
    if (validationDetails === null) {
      return createErrorEnvelope('KB_PLUGIN_CONTRACT_VIOLATION', {
        ...options,
        message: 'Error details must be a flat map of string identifiers.',
        hint: 'Keep error.details values as identifiers; return structured reports in data or gate findings in error.diagnostics.',
        details: contractViolationDetailsFor('details', source.details),
      });
    }
    return createErrorEnvelope('KB_RUNTIME_INPUT_INVALID', {
      ...options,
      ...(validationDetails && Object.keys(validationDetails).length > 0 ? { details: validationDetails } : {}),
    });
  }
  const sourceCode = typeof source?.code === 'string' ? source.code
    : typeof source?.errorCode === 'string' ? source.errorCode : undefined;
  if (source && sourceCode && isSystemErrorRecord(source)) {
    return createErrorEnvelope('KB_RUNTIME_UNEXPECTED', options);
  }
  const code = sourceCode && isErrorCode(sourceCode) ? sourceCode : 'KB_RUNTIME_UNEXPECTED';
  const details = getDetails(source?.details);
  if (details === null) {
    return createErrorEnvelope('KB_PLUGIN_CONTRACT_VIOLATION', {
      ...options,
      message: 'Error details must be a flat map of string identifiers.',
      hint: 'Keep error.details values as identifiers; return structured reports in data or gate findings in error.diagnostics.',
      details: contractViolationDetailsFor('details', source?.details),
    });
  }

  const correlationId = typeof source?.correlationId === 'string'
    ? source.correlationId
    : options.correlationId ?? (code === 'KB_RUNTIME_UNEXPECTED' ? globalThis.crypto.randomUUID() : undefined);
  const message = code !== 'KB_RUNTIME_UNEXPECTED' && !('errorCode' in (source ?? {})) && typeof source?.message === 'string'
    ? source.message
    : undefined;
  const cause = code === 'KB_RUNTIME_UNEXPECTED'
    ? typeof error === 'string' ? error : undefined
    : typeof source?.cause === 'string'
    ? source.cause
    : error instanceof Error && message !== error.message
      ? error.message
      : typeof error === 'string' && message !== error
        ? error
        : undefined;
  const hint = code !== 'KB_RUNTIME_UNEXPECTED' && typeof source?.hint === 'string'
    ? source.hint
    : undefined;
  const diagnostics = Array.isArray(source?.diagnostics)
    ? source.diagnostics as ErrorEnvelope['diagnostics']
    : undefined;

  if (sourceCode && !sourceCode.startsWith('KB_')) {
    const productHint = source?.hint;
    if (typeof productHint !== 'string' || productHint.length === 0) {
      return createErrorEnvelope('KB_PLUGIN_CONTRACT_VIOLATION', {
        ...options,
        message: `Product error "${sourceCode}" must include a non-empty hint.`,
        hint: 'Return a product error with a <PLUGIN>_<CONDITION> code, message, hint, and flat string details.',
        details: { field: 'hint', ...describeContractValue(productHint) },
      });
    }
    try {
      const productDetails = details ?? {};
      const statusCode = typeof source?.statusCode === 'number' ? source.statusCode : undefined;
      return createProductErrorEnvelope({
        ...options,
        code: sourceCode,
        message: typeof source?.message === 'string' ? source.message : '',
        hint: productHint,
        retryable: statusCode !== undefined && isRetryableStatus(statusCode),
        details: { ...productDetails, ...(statusCode !== undefined ? { statusCode: String(statusCode) } : {}) },
        ...(typeof source?.correlationId === 'string' ? { correlationId: source.correlationId } : {}),
        ...(diagnostics ? { diagnostics } : {}),
      });
    } catch (error) {
      if (isContractViolation(error)) {
        return createErrorEnvelope('KB_PLUGIN_CONTRACT_VIOLATION', {
          ...options,
          message: error.message,
          hint: error.hint,
          details: contractViolationDetails(error),
        });
      }
      throw error;
    }
  }
  if (sourceCode?.startsWith('KB_') && !isErrorCode(sourceCode)) {
    return createErrorEnvelope('KB_PLUGIN_CONTRACT_VIOLATION', {
      ...options,
      message: `Plugin returned uncatalogued platform code "${sourceCode}".`,
      hint: 'Use a KB_* code from the platform error catalog, or a valid product code with a hint.',
      details: contractViolationDetailsFor('code', sourceCode),
    });
  }

  try {
    const entry = getCatalogEntry(code);
    const templateValues = options.binary && entry?.runtimeTemplateParameters?.binary === 'required'
      ? { binary: options.binary }
      : undefined;
    return createUntrustedErrorEnvelope(code, {
      ...options,
      ...(templateValues ? { templateValues } : {}),
      ...(cause ? { cause } : {}),
      ...(message ? { message } : {}),
      ...(hint ? { hint } : {}),
      ...(details && Object.keys(details).length > 0 ? { details } : {}),
      ...(diagnostics ? { diagnostics } : {}),
      ...(correlationId ? { correlationId } : {}),
    });
  } catch (error) {
    if (isContractViolation(error)) {
      return createErrorEnvelope('KB_PLUGIN_CONTRACT_VIOLATION', {
        message: error.message,
        hint: error.hint,
        ...('field' in error && typeof error.field === 'string' ? { details: { ...contractViolationDetails(error) } } : {}),
      });
    }
    throw error;
  }
}

/** Revalidates any envelope-shaped value through the single namespace contract. */
export function canonicalizeErrorEnvelope(envelope: ErrorEnvelope, options: ToEnvelopeOptions = {}): ValidatedErrorEnvelope {
  const issues = validateErrorEnvelope(envelope);
  if (issues.length > 0) {
    const issue = issues[0]!;
    return createErrorEnvelope('KB_PLUGIN_CONTRACT_VIOLATION', {
      ...options,
      message: `Plugin returned malformed error field "${issue.field}": ${issue.reason}.`,
      hint: 'Return a product error with a valid error envelope.',
      details: { field: issue.field, ...describeContractValue(readField(envelope, issue.field)) },
    });
  }
  try {
    const fields = {
      message: envelope.message,
      hint: envelope.hint,
      ...(envelope.details ? { details: envelope.details } : {}),
      ...(envelope.cause ? { cause: envelope.cause } : {}),
      ...(envelope.correlationId ? { correlationId: envelope.correlationId } : {}),
      ...(envelope.actions ? { actions: envelope.actions } : {}),
      ...(envelope.docs ? { docs: envelope.docs } : {}),
      ...(envelope.diagnostics ? { diagnostics: envelope.diagnostics } : {}),
    };
    if (isErrorCode(envelope.code)) {
      const entry = getCatalogEntry(envelope.code);
      const templateValues = options.binary && entry?.runtimeTemplateParameters?.binary === 'required'
        ? { binary: options.binary }
        : undefined;
      return assertCanonicalEnvelope(createUntrustedErrorEnvelope(envelope.code, {
        ...options,
        ...fields,
        ...(templateValues ? { templateValues } : {}),
      }));
    }
    return assertCanonicalEnvelope(createProductErrorEnvelope({
      ...options,
      ...fields,
      code: envelope.code,
      retryable: envelope.retryable,
    }));
  } catch (cause) {
    if (isContractViolation(cause)) {
      return createErrorEnvelope('KB_PLUGIN_CONTRACT_VIOLATION', {
        ...options,
        message: cause.message,
        hint: cause.hint,
        details: contractViolationDetails(cause),
      });
    }
    throw cause;
  }
}

/** Reconstructs a received catalogued envelope from its code and generated structured-detail contract. */
export function decodeErrorEnvelope(envelope: unknown, options: DecodeEnvelopeOptions = {}): ValidatedErrorEnvelope {
  const { protocolDetails = {}, presentation = 'catalog', ...envelopeOptions } = options;
  const validationIssues = validateErrorEnvelope(envelope);
  if (validationIssues.length > 0 || !isErrorEnvelope(envelope)) {
    const remoteCode = typeof envelope === 'object' && envelope !== null && 'code' in envelope && typeof envelope.code === 'string'
      ? envelope.code
      : 'unknown';
    return createErrorEnvelope('KB_RUNTIME_GATEWAY_PROTOCOL_FAILURE', {
      ...envelopeOptions,
      details: {
        ...protocolDetails,
        remoteCode,
        fields: validationIssues.map((issue) => issue.field).join(','),
      },
    });
  }
  if (!isErrorCode(envelope.code)) return canonicalizeErrorEnvelope(envelope, envelopeOptions);

  const details = envelope.details ?? {};

  try {
    const reconstructed = createUntrustedErrorEnvelope(envelope.code, {
      ...envelopeOptions,
      ...(envelope.correlationId ? { correlationId: envelope.correlationId } : {}),
      ...(envelope.cause ? { cause: envelope.cause } : {}),
      ...(presentation === 'handler' ? { message: envelope.message, hint: envelope.hint } : {}),
      ...(Object.keys(details).length > 0 ? { details } : {}),
      ...(envelope.diagnostics ? { diagnostics: envelope.diagnostics } : {}),
    });
    if (reconstructed.code === 'KB_RUNTIME_DIAGNOSTIC_CONTRACT_VIOLATION' && envelope.code !== reconstructed.code) {
      return createErrorEnvelope('KB_RUNTIME_GATEWAY_PROTOCOL_FAILURE', {
        ...envelopeOptions,
        details: {
          ...protocolDetails,
          remoteCode: envelope.code,
          fields: typeof reconstructed.details?.fields === 'string' ? reconstructed.details.fields : 'details',
        },
      });
    }
    return reconstructed;
  } catch {
    return createErrorEnvelope('KB_RUNTIME_GATEWAY_PROTOCOL_FAILURE', {
      ...envelopeOptions,
      details: { ...protocolDetails, remoteCode: envelope.code },
    });
  }
}

function assertCanonicalEnvelope(envelope: ErrorEnvelope): ValidatedErrorEnvelope {
  const problems = validateErrorEnvelope(envelope);
  if (problems.length > 0) {
    const issue = problems[0]!;
    throw productContractViolation(`Failure envelope field "${issue.field}" ${issue.reason}.`, issue.field, readField(envelope, issue.field));
  }
  return markValidatedErrorEnvelope(envelope);
}

type ErrorRecord = Partial<TypedPlatformError> & Record<string, unknown>;

function getErrorRecord(error: unknown): ErrorRecord | undefined {
  if (error instanceof Error) {
    return error as Error & ErrorRecord;
  }
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  if ('error' in error && typeof error.error === 'object' && error.error !== null) {
    return error.error as ErrorRecord;
  }
  return error as ErrorRecord;
}

function isSystemErrorRecord(source: ErrorRecord): boolean {
  return 'errno' in source || 'syscall' in source;
}

function getDetails(value: unknown): Record<string, string> | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.some(([, item]) => typeof item !== 'string' || isSerializedStructuredValue(item))) return null;
  return Object.fromEntries(entries) as Record<string, string>;
}

function isContractViolation(error: unknown): error is Error & { code: string; hint: string; field: string } {
  return error instanceof Error && 'code' in error && error.code === 'KB_PLUGIN_CONTRACT_VIOLATION'
    && 'hint' in error && typeof error.hint === 'string'
    && 'field' in error && typeof error.field === 'string';
}

export interface ProductErrorInput extends ToEnvelopeOptions {
  code: string;
  message: string;
  hint: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

/** Builds and validates a product error for both thrown and returned failures. */
export function createProductErrorEnvelope(input: ProductErrorInput): ValidatedErrorEnvelope & { code: ProductErrorCode } {
  if (typeof input.code !== 'string' || !/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(input.code) || input.code.startsWith('KB_')) {
    throw productContractViolation(`Product error code "${input.code}" must match <PLUGIN>_<CONDITION> and must not use the KB_ prefix.`, 'code', input.code);
  }
  if (typeof input.message !== 'string' || input.message.length === 0) {
    throw productContractViolation(`Product error "${input.code}" must include a non-empty message.`, 'message', input.message);
  }
  if (typeof input.hint !== 'string' || input.hint.length === 0) {
    throw productContractViolation(`Product error "${input.code}" must include a non-empty hint.`, 'hint', input.hint);
  }
  if (typeof input.retryable !== 'boolean') {
    throw productContractViolation(`Product error "${input.code}" must declare whether it is retryable.`, 'retryable', input.retryable);
  }
  if (input.details !== undefined && (typeof input.details !== 'object' || input.details === null || Array.isArray(input.details))) {
    throw createErrorDetailsContractViolation('details', 'must be a flat map of string identifiers', input.details);
  }
  for (const [key, value] of Object.entries(input.details ?? {})) {
    if (typeof value !== 'string' || isSerializedStructuredValue(value)) {
      throw createErrorDetailsContractViolation(key, 'must be a flat map of string identifiers', value);
    }
  }
  const envelope: ErrorEnvelope & { code: ProductErrorCode } = {
    code: input.code as ProductErrorCode,
    area: 'product',
    stage: 'run',
    severity: 'error',
    retryable: input.retryable,
    message: input.message,
    hint: input.hint,
  };
  if (input.details && Object.keys(input.details).length > 0) envelope.details = input.details;
  if (input.correlationId) envelope.correlationId = input.correlationId;
  if (input.actions?.length) envelope.actions = input.actions;
  if (input.docs) envelope.docs = input.docs;
  if (input.diagnostics?.length) envelope.diagnostics = input.diagnostics;
  return markValidatedErrorEnvelope(envelope);
}

function productContractViolation(message: string, field: string, observedValue: unknown): Error & { code: string; hint: string; field: string; observedType: string; observedValuePreview: string } {
  const evidence = describeContractValue(observedValue);
  return Object.assign(new Error(message), {
    code: 'KB_PLUGIN_CONTRACT_VIOLATION',
    hint: 'Return a product error with a <PLUGIN>_<CONDITION> code, message, hint, and flat string details.',
    field,
    ...evidence,
  });
}

function contractViolationDetails(error: Error & { field?: string; observedType?: string; observedValuePreview?: string }): Record<string, string> {
  return {
    ...(error.field ? { field: error.field } : {}),
    ...(error.observedType ? { observedType: error.observedType } : {}),
    ...(error.observedValuePreview ? { observedValuePreview: error.observedValuePreview } : {}),
  };
}

function contractViolationDetailsFor(field: string, value: unknown): Record<string, string> {
  return { field, ...describeContractValue(value) };
}

function readField(value: unknown, field: string): unknown {
  if (field === 'envelope') return value;
  if (typeof value !== 'object' || value === null) return undefined;
  let current: unknown = value;
  for (const segment of field.split('.')) {
    if (typeof current !== 'object' || current === null || !(segment in current)) return undefined;
    current = Reflect.get(current, segment);
  }
  return current;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export function isRetryableStatus(statusCode: number): boolean {
  return RETRYABLE_STATUS.has(statusCode);
}
