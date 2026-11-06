import {
  createContextLogger,
  createErrorEnvelope,
  describeContractValue,
  ErrorEnvelopeError,
  toErrorEnvelope,
  validateErrorEnvelope,
  hasErrorEnvelopeIdentity,
  isErrorCode,
  serializeError,
  type SerializedError,
  type ErrorEnvelope,
  type DetailsFor,
  type ILogger,
  type PlatformLogContext,
} from '@kb-labs/core-platform';

export interface PluginHandlerFailureContext {
  pluginId: string;
  pluginVersion: string;
  command: string;
  correlationId: string;
  logger: ILogger;
  logContext: PlatformLogContext;
  returnedFailure?: boolean;
  diagnosticStack?: string;
  workerDiagnostic?: import('@kb-labs/core-platform').ExecutionDiagnostics['worker'];
  serializedError?: SerializedError;
  returnedFailureError?: unknown;
  executionEnvelope?: ErrorEnvelope;
}

type FailureReason = 'failed unexpectedly' | 'timed out' | 'execution process crashed';

function recordPluginFailure(
  context: PluginHandlerFailureContext,
  envelope: ErrorEnvelope,
  error: SerializedError,
  reason: string,
  diagnosticStack?: string,
  malformedField?: string,
  evidenceType?: string,
  evidencePreview?: string,
  sourceFailure?: { sourceCode?: string; sourceErrorClass: string; sourceMessage?: string; failureMode: 'thrown' | 'returned'; sourceHintType: string },
): void {
  const logger = createContextLogger(context.logger, context.logContext)
    .forOperation('plugin.handler.failed', { correlationId: context.correlationId })
    .forPlugin({ pluginId: context.pluginId });
  const logError = asError(error);
  const stack = diagnosticStack ?? error.stack;
  if (stack) {
    logError.stack = stack;
  }
  logger.event('error', {
    event: 'plugin.handler.failed',
    message: sourceFailure && envelope.code === 'KB_PLUGIN_CONTRACT_VIOLATION'
      ? 'Plugin handler failure did not satisfy the error envelope contract.'
      : envelope.message,
    fields: {
      code: envelope.code,
      pluginId: context.pluginId,
      pluginVersion: context.pluginVersion,
      command: context.command,
      failureReason: reason,
      correlationId: context.correlationId,
      ...(context.workerDiagnostic ? { worker: context.workerDiagnostic } : {}),
      ...(sourceFailure ? {
        ...(sourceFailure.sourceCode ? { sourceCode: sourceFailure.sourceCode } : {}),
        sourceErrorClass: sourceFailure.sourceErrorClass,
        ...(sourceFailure.sourceMessage ? { sourceMessage: sourceFailure.sourceMessage } : {}),
        failureMode: sourceFailure.failureMode,
        sourceHintType: sourceFailure.sourceHintType,
      } : {}),
      ...(!sourceFailure || envelope.code !== 'KB_PLUGIN_CONTRACT_VIOLATION'
        ? { serializedError: logger.redactSensitiveValues(error) }
        : {}),
      ...(malformedField ? {
        malformedField,
        malformedFieldType: evidenceType,
        ...(!sourceFailure || envelope.code !== 'KB_PLUGIN_CONTRACT_VIOLATION' ? { malformedFieldPreview: evidencePreview } : {}),
      } : {}),
    },
    ...(!sourceFailure || envelope.code !== 'KB_PLUGIN_CONTRACT_VIOLATION' ? { error: logError } : {}),
  });
}

function failureReason(error: unknown): FailureReason {
  if (typeof error === 'object' && error !== null && 'details' in error &&
      typeof error.details === 'object' && error.details !== null && 'failureReason' in error.details) {
    const reason = error.details.failureReason;
    if (reason === 'timed out' || reason === 'execution process crashed') return reason;
  }
  if (error instanceof Error && error.name === 'TimeoutError') return 'timed out';
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'TIMEOUT') return 'timed out';
  if (error instanceof Error && error.name === 'WorkerCrashedError') return 'execution process crashed';
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'WORKER_CRASHED') return 'execution process crashed';
  return 'failed unexpectedly';
}

function missingModuleSpecifier(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  if ('moduleResolution' in error && typeof error.moduleResolution === 'object' && error.moduleResolution !== null &&
      'specifier' in error.moduleResolution && typeof error.moduleResolution.specifier === 'string') {
    return error.moduleResolution.specifier;
  }
  if ('code' in error && (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'MODULE_NOT_FOUND') &&
      'specifier' in error && typeof error.specifier === 'string' && error.specifier.length > 0) {
    return error.specifier;
  }
  return undefined;
}

function asError(error: SerializedError): Error {
  const logError = new Error(error.message);
  logError.name = error.name;
  logError.stack = error.stack;
  return logError;
}

/** The platform-owned normaliser for every plugin handler failure surface. */
export function normalizePluginHandlerFailure(
  error: unknown,
  context: PluginHandlerFailureContext,
): ErrorEnvelope {
  const reason = failureReason(error);
  const returnedCandidate = context.returnedFailureError;
  const envelopeCandidate = returnedCandidate !== undefined
    ? returnedCandidate
    : context.executionEnvelope
      ? context.executionEnvelope
    : error instanceof ErrorEnvelopeError
      ? error.envelope
      : typeof error === 'object' && error !== null && 'envelope' in error
        ? error.envelope
        : typeof error === 'object' && error !== null && 'error' in error
          ? error.error
          : error;
  const candidateHasEnvelopeFields = hasErrorEnvelopeIdentity(envelopeCandidate);
  const thinCommandError = typeof envelopeCandidate === 'object' && envelopeCandidate !== null &&
    !Array.isArray(envelopeCandidate) && !(envelopeCandidate instanceof Error) &&
    'code' in envelopeCandidate && typeof envelopeCandidate.code === 'string';
  const sourceCode = typeof envelopeCandidate === 'object' && envelopeCandidate !== null && 'code' in envelopeCandidate
    ? envelopeCandidate.code
    : undefined;
  const candidateIssues = candidateHasEnvelopeFields ? validateErrorEnvelope(envelopeCandidate) : [];
  const cataloguedHintRepair = candidateIssues.length === 1 && candidateIssues[0]?.field === 'hint' &&
    invalidHintCanUseCatalog(envelopeCandidate, sourceCode)
    ? toErrorEnvelope(withoutHint(envelopeCandidate), { correlationId: context.correlationId })
    : undefined;
  const validationIssues = cataloguedHintRepair
    ? validateErrorEnvelope(cataloguedHintRepair)
    : candidateIssues;
  const invalidEnvelopeIssue = validationIssues[0];
  const typedEnvelope = returnedCandidate !== undefined
    ? (candidateHasEnvelopeFields && validationIssues.length === 0) || thinCommandError
    : error instanceof ErrorEnvelopeError ||
      (candidateHasEnvelopeFields && validationIssues.length === 0) || thinCommandError;
  const canonicalEnvelope = !invalidEnvelopeIssue && typedEnvelope
    ? cataloguedHintRepair ?? toErrorEnvelope(error instanceof ErrorEnvelopeError ? error : envelopeCandidate, { correlationId: context.correlationId })
    : undefined;
  const contractEnvelope = canonicalEnvelope?.code === 'KB_PLUGIN_CONTRACT_VIOLATION' ||
    canonicalEnvelope?.code === 'KB_RUNTIME_DIAGNOSTIC_CONTRACT_VIOLATION'
    ? canonicalEnvelope
    : undefined;
  const contractDetails = contractEnvelope?.details as DetailsFor<'KB_PLUGIN_CONTRACT_VIOLATION'> |
    DetailsFor<'KB_RUNTIME_DIAGNOSTIC_CONTRACT_VIOLATION'> | undefined;
  const contractField = contractDetails?.field
    ? contractDetails.field
    : undefined;
  const malformedField = invalidEnvelopeIssue?.field ??
    contractField ??
    (context.returnedFailure && !typedEnvelope ? 'envelope' : undefined);
  const malformedValue = malformedField === 'envelope'
    ? envelopeCandidate
    : typeof envelopeCandidate === 'object' && envelopeCandidate !== null
      ? Reflect.get(envelopeCandidate, malformedField ?? '')
      : undefined;
  const contextLogger = createContextLogger(context.logger, context.logContext);
  const sourceIdentityCandidate = returnedCandidate ?? context.serializedError ?? envelopeCandidate;
  const sourceFailure = describeSourceFailure(sourceIdentityCandidate, context.returnedFailure === true ? 'returned' : 'thrown', contextLogger);
  const observedEvidence = contractDetails?.observedType &&
    contractDetails.observedValuePreview
    ? {
        observedType: contractDetails.observedType,
        observedValuePreview: contractDetails.observedValuePreview,
      }
    : describeContractValue(malformedValue);
  const safeObservedEvidence = {
    observedType: observedEvidence.observedType,
    observedValuePreview: contextLogger.redactSensitiveValues(observedEvidence.observedValuePreview).slice(0, 256),
  };
  const malformedReturn = Boolean(invalidEnvelopeIssue) ||
    Boolean(context.returnedFailure && !typedEnvelope) ||
    canonicalEnvelope?.code === 'KB_PLUGIN_CONTRACT_VIOLATION';
  const specifier = context.returnedFailure
    ? undefined
    : missingModuleSpecifier(context.serializedError) ?? missingModuleSpecifier(envelopeCandidate);
  const rawEnvelope = specifier
    ? createErrorEnvelope('KB_PLUGIN_LOAD_FAILED', {
        correlationId: context.correlationId,
        details: { plugin: context.pluginId, command: context.command, specifier },
      })
    : malformedReturn
    ? createErrorEnvelope('KB_PLUGIN_CONTRACT_VIOLATION', {
        correlationId: context.correlationId,
        message: `Plugin ${context.pluginId} command ${context.command} returned malformed error field "${malformedField}".`,
        hint: 'Return a valid product or platform error envelope.',
        details: {
          plugin: context.pluginId,
          command: context.command,
          field: malformedField ?? 'envelope',
          ...safeObservedEvidence,
          ...sourceFailureDetails(sourceFailure),
        },
      })
    : canonicalEnvelope?.code === 'KB_PLUGIN_COMMAND_FAILED'
      ? createErrorEnvelope('KB_PLUGIN_COMMAND_FAILED', {
          correlationId: context.correlationId,
          message: canonicalEnvelope.message,
          hint: canonicalEnvelope.hint,
          details: { ...((canonicalEnvelope.details ?? {}) as DetailsFor<'KB_PLUGIN_COMMAND_FAILED'>), ...sourceFailureDetails(sourceFailure) },
        })
    : canonicalEnvelope
      ? canonicalEnvelope
      : createErrorEnvelope('KB_PLUGIN_COMMAND_FAILED', {
          correlationId: context.correlationId,
          details: {
            plugin: context.pluginId,
            command: context.command,
            failureReason: reason,
            ...sourceFailureDetails(sourceFailure),
          },
        });
  const envelope = contextLogger.redactSensitiveValues(rawEnvelope);
  if (typedEnvelope) {
    recordPluginFailure(context, envelope, serializeError(returnedCandidate ?? context.serializedError ?? error), 'typed product or platform error', context.diagnosticStack, malformedField, safeObservedEvidence.observedType, safeObservedEvidence.observedValuePreview,
      envelope.code === 'KB_PLUGIN_CONTRACT_VIOLATION' || envelope.code === 'KB_PLUGIN_COMMAND_FAILED' ? sourceFailure : undefined);
    return envelope;
  }
  recordPluginFailure(context, envelope, context.serializedError ?? serializeError(error), reason, context.diagnosticStack, malformedField, safeObservedEvidence.observedType, safeObservedEvidence.observedValuePreview,
    malformedReturn || envelope.code === 'KB_PLUGIN_COMMAND_FAILED' ? sourceFailure : undefined);
  return envelope;
}

function describeSourceFailure(
  value: unknown,
  failureMode: 'thrown' | 'returned',
  logger: ReturnType<typeof createContextLogger>,
): { sourceCode?: string; sourceErrorClass: string; sourceMessage?: string; failureMode: 'thrown' | 'returned'; sourceHintType: string } {
  const sourceCode = typeof value === 'object' && value !== null && 'code' in value && typeof value.code === 'string'
    ? value.code
    : undefined;
  const sourceErrorClass = value instanceof Error
    ? value.name || value.constructor.name
    : typeof value === 'object' && value !== null && 'name' in value && typeof value.name === 'string'
      ? value.name
    : typeof value === 'object' && value !== null && value.constructor?.name
      ? value.constructor.name
      : typeof value;
  const sourceMessage = typeof value === 'object' && value !== null && 'message' in value && typeof value.message === 'string'
    ? logger.redactSensitiveValues(value.message).slice(0, 256)
    : undefined;
  return {
    ...(sourceCode ? { sourceCode: logger.redactSensitiveValues(sourceCode).slice(0, 256) } : {}),
    sourceErrorClass: logger.redactSensitiveValues(sourceErrorClass).slice(0, 128),
    ...(sourceMessage ? { sourceMessage } : {}),
    failureMode,
    sourceHintType: sourceHintType(value),
  };
}

function sourceFailureDetails(
  sourceFailure: ReturnType<typeof describeSourceFailure>,
): Record<string, string> {
  return {
    ...(sourceFailure.sourceCode ? { sourceCode: sourceFailure.sourceCode } : {}),
    sourceErrorClass: sourceFailure.sourceErrorClass,
    ...(sourceFailure.sourceMessage ? { sourceMessage: sourceFailure.sourceMessage } : {}),
    failureMode: sourceFailure.failureMode,
  };
}

function sourceHintType(value: unknown): string {
  if (typeof value !== 'object' || value === null || !Object.hasOwn(value, 'hint')) return 'absent';
  const hint = Reflect.get(value, 'hint');
  if (hint === undefined) return 'undefined';
  if (hint === null) return 'null';
  return typeof hint;
}

function invalidHintCanUseCatalog(value: unknown, code: unknown): value is Record<string, unknown> {
  return hasErrorEnvelopeIdentity(value) && typeof code === 'string' && isErrorCode(code) &&
    Object.hasOwn(value, 'hint') && typeof Reflect.get(value, 'hint') !== 'string';
}

function withoutHint(value: Record<string, unknown>): Record<string, unknown> {
  const canonical = { ...value };
  delete canonical.hint;
  return canonical;
}
