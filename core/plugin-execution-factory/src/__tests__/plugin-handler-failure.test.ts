import { describe, expect, it } from 'vitest';
import {
  createContextLogger,
  createErrorEnvelope,
  createProductErrorEnvelope,
  ErrorEnvelopeError,
  ErrorEnvelopeJsonSchema,
  hasErrorEnvelopeIdentity,
  validateErrorEnvelope,
  type IContextLogger,
} from '@kb-labs/core-platform';
import { handleError } from '@kb-labs/shared-cli-ui';
import { normalizePluginHandlerFailure } from '../plugin-handler-failure.js';

function loggerFor(records: Array<Record<string, unknown>>): IContextLogger {
  const write = (level: string, message: string, error?: Error, fields?: Record<string, unknown>) => {
    records.push({ level, message, ...(error ? { error } : {}), ...(fields ?? {}) });
  };
  return createContextLogger({
    trace: () => {}, debug: () => {}, info: () => {}, warn: () => {},
    error: (message, error, fields) => write('error', message, error, fields),
    fatal: (message, error, fields) => write('fatal', message, error, fields),
    flush: async () => {},
    child: () => loggerFor(records),
  }, logContext);
}

const logContext = {
  applicationId: 'cli',
  serviceId: 'plugin-execution',
  instanceId: 'test-instance',
  layer: 'runtime',
};

describe('normalizePluginHandlerFailure', () => {
  // S-243.8: module-load failures keep the catalogued plugin/command/specifier contract.
  it('classifies handler module resolution failures as plugin load failures', () => {
    const records: Array<Record<string, unknown>> = [];
    const serializedError = {
      name: 'Error',
      message: "Cannot find package '@kb-labs/shared-command-kit'",
      moduleResolution: {
        code: 'ERR_MODULE_NOT_FOUND' as const,
        specifier: '@kb-labs/shared-command-kit',
      },
    };
    const executionEnvelope = createErrorEnvelope('KB_PLUGIN_COMMAND_FAILED', {
      correlationId: 'module-load-correlation',
      details: {
        plugin: '@kb-labs/commit', command: 'commit plan delete', failureReason: 'failed unexpectedly',
      },
    });

    const envelope = normalizePluginHandlerFailure(executionEnvelope, {
      pluginId: '@kb-labs/commit', command: 'commit plan delete', correlationId: 'module-load-correlation',
      pluginVersion: '2.122.1', serializedError, executionEnvelope,
      logger: loggerFor(records), logContext,
    });

    expect(envelope).toMatchObject({
      code: 'KB_PLUGIN_LOAD_FAILED',
      correlationId: 'module-load-correlation',
      details: {
        plugin: '@kb-labs/commit', command: 'commit plan delete',
        specifier: '@kb-labs/shared-command-kit',
      },
    });
    expect(envelope.hint).toBeTruthy();
    expect(envelope.message).not.toContain('malformed error field');
  });

  it.each([
    new ErrorEnvelopeError(createProductErrorEnvelope({
      code: 'MIND_NOT_FOUND', retryable: false, message: 'Mind result was not found.',
      hint: 'Choose an existing mind.', details: { id: 'missing' },
    })),
    new ErrorEnvelopeError(createErrorEnvelope('KB_ADAPTER_NOT_CONFIGURED', {
      details: { service: 'llm', adapter: 'platform.adapters.llm', command: 'kb adapter bind llm' },
    })),
  ])('passes a valid typed product or platform envelope through unchanged', (cause) => {
    const records: Array<Record<string, unknown>> = [];
    const expected = cause instanceof ErrorEnvelopeError ? cause.envelope : undefined;
    const envelope = normalizePluginHandlerFailure(cause, {
      pluginId: '@kb-labs/test-plugin', command: 'test run', correlationId: 'typed-correlation',
      pluginVersion: '1.0.0',
      logger: loggerFor(records), logContext,
    });
    expect(envelope).toEqual({ ...expected, correlationId: 'typed-correlation' });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      code: expected?.code,
      correlationId: 'typed-correlation',
      event: 'plugin.handler.failed',
    });
  });

  it('returns a plugin-named contract violation for a product error missing its hint', () => {
    const records: Array<Record<string, unknown>> = [];
    const envelope = normalizePluginHandlerFailure({ code: 'MIND_NOT_FOUND', message: 'Missing' }, {
      pluginId: '@kb-labs/test-plugin', command: 'test run', correlationId: 'malformed-correlation',
      pluginVersion: '1.0.0',
      logger: loggerFor(records), logContext,
    });
    expect(envelope).toMatchObject({
      code: 'KB_PLUGIN_CONTRACT_VIOLATION', correlationId: 'malformed-correlation',
      message: expect.stringContaining('@kb-labs/test-plugin'), details: { field: 'hint' },
    });
    expect(records).toHaveLength(1);
  });

  it.each([undefined, { remedy: 'invalid-shape' }])('rebuilds catalogued platform errors with a malformed hint through the shared envelope owner', (hint) => {
    const records: Array<Record<string, unknown>> = [];
    const malformed = { ...createErrorEnvelope('KB_RUNTIME_UNEXPECTED', { correlationId: 'missing-hint-correlation' }), hint };
    const envelope = normalizePluginHandlerFailure(malformed, {
      pluginId: '@kb-labs/test-plugin', command: 'test run', correlationId: 'missing-hint-correlation',
      pluginVersion: '1.0.0',
      returnedFailure: true,
      returnedFailureError: malformed,
      logger: loggerFor(records), logContext,
    });

    expect(envelope.code).toBe('KB_RUNTIME_UNEXPECTED');
    expect(envelope.hint).toBeTruthy();
    expect(envelope.correlationId).toBe('missing-hint-correlation');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ code: 'KB_RUNTIME_UNEXPECTED', event: 'plugin.handler.failed' });
  });

  it.each([
    [{ code: 'MIND_INVALID', message: 'source message marker' }, 'absent'],
    [{ code: 'MIND_INVALID', message: 'source message marker', hint: undefined }, 'undefined'],
    [{ code: 'MIND_INVALID', message: 'source message marker', hint: null }, 'null'],
    [{ code: 'MIND_INVALID', message: 'source message marker', hint: '' }, 'string'],
    [{ code: 'MIND_INVALID', message: 'source message marker', hint: { value: 'source hint marker' } }, 'object'],
    [{ code: 'MIND_INVALID', message: 'source message marker', hint: 17 }, 'number'],
  ])('logs safe source error diagnostics when rejecting a plugin result (%s)', (candidate, sourceHintType) => {
    const records: Array<Record<string, unknown>> = [];
    const envelope = normalizePluginHandlerFailure(candidate, {
      pluginId: '@kb-labs/test-plugin',
      pluginVersion: '1.0.0',
      command: 'test run',
      correlationId: 'source-diagnostic-correlation',
      returnedFailure: true,
      returnedFailureError: candidate,
      logger: loggerFor(records),
      logContext,
    });

    expect(envelope.code).toBe('KB_PLUGIN_CONTRACT_VIOLATION');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      event: 'plugin.handler.failed',
      correlationId: 'source-diagnostic-correlation',
      sourceCode: 'MIND_INVALID',
      sourceHintType,
      pluginId: '@kb-labs/test-plugin',
      command: 'test run',
    });
  });

  it('logs and returns source failure identity without exposing malformed hint values', () => {
    const records: Array<Record<string, unknown>> = [];
    const sourceMessage = 'private-source-message-marker';
    const sourceHint = 'private-source-hint-marker';
    const candidate = { code: 'MIND_INVALID', message: sourceMessage, hint: { token: sourceHint } };

    const envelope = normalizePluginHandlerFailure(candidate, {
      pluginId: '@kb-labs/test-plugin',
      pluginVersion: '1.0.0',
      command: 'test run',
      correlationId: 'source-secret-correlation',
      returnedFailure: true,
      returnedFailureError: candidate,
      logger: loggerFor(records),
      logContext,
    });

    expect(records).toHaveLength(1);
    const serializedEvent = JSON.stringify(records[0]);
    expect(serializedEvent).toContain(sourceMessage);
    expect(serializedEvent).not.toContain(sourceHint);
    expect(envelope.details).toMatchObject({
      sourceCode: 'MIND_INVALID',
      sourceErrorClass: 'Object',
      sourceMessage,
      failureMode: 'returned',
    });
    expect(envelope.details?.sourceMessage).not.toContain(sourceHint);
    expect(records[0]).not.toHaveProperty('malformedFieldPreview');
    expect(records[0]).not.toHaveProperty('serializedError');
    expect(records[0]).not.toHaveProperty('error');
  });

  it('records malformed field type and a bounded redacted preview with plugin provenance', () => {
    const records: Array<Record<string, unknown>> = [];
    const logger = loggerFor(records);
    const secret = 'x58-malformed-hint-secret';
    logger.registerSensitiveValues([secret]);
    const envelope = normalizePluginHandlerFailure({
      code: 'MIND_INVALID',
      message: 'Invalid mind.',
      hint: { token: secret, extra: 'x'.repeat(400) },
    }, {
      pluginId: '@kb-labs/test-plugin',
      pluginVersion: '2.120.1',
      command: 'test open',
      correlationId: 'malformed-hint-correlation',
      logger,
      logContext,
    });

    expect(envelope).toMatchObject({ code: 'KB_PLUGIN_CONTRACT_VIOLATION', details: { field: 'hint' } });
    expect(envelope.details).toMatchObject({
      observedType: 'object',
      observedValuePreview: expect.stringContaining('[REDACTED]'),
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      event: 'plugin.handler.failed',
      pluginId: '@kb-labs/test-plugin',
      pluginVersion: '2.120.1',
      command: 'test open',
      malformedField: 'hint',
      malformedFieldType: 'object',
    });
    expect(records[0]).not.toHaveProperty('malformedFieldPreview');
    const record = JSON.stringify(records[0]);
    expect(record).not.toContain(secret);
    expect(JSON.stringify(envelope.details)).not.toContain(secret);
    const observedValuePreview = envelope.details?.observedValuePreview;
    if (typeof observedValuePreview !== 'string') throw new Error('observed value preview must be a string');
    expect(observedValuePreview.length).toBeLessThanOrEqual(256);
  });

  it('preserves diagnostic detail violations with redacted field evidence in the envelope and correlated log', () => {
    const records: Array<Record<string, unknown>> = [];
    const logger = loggerFor(records);
    const secret = 'x81-diagnostic-detail-secret';
    logger.registerSensitiveValues([secret]);
    const invalidConfigDetails = { path: 'platform.yaml', gatewayUrl: `${secret}${'x'.repeat(400)}` };
    const diagnostic = createErrorEnvelope('KB_CONFIG_INVALID', {
      details: invalidConfigDetails,
    });
    const envelope = normalizePluginHandlerFailure(diagnostic, {
      pluginId: '@kb-labs/test-plugin',
      pluginVersion: '1.0.0',
      command: 'test run',
      correlationId: 'diagnostic-contract-correlation',
      logger,
      logContext,
    });

    expect(envelope).toMatchObject({
      code: 'KB_RUNTIME_DIAGNOSTIC_CONTRACT_VIOLATION',
      correlationId: 'diagnostic-contract-correlation',
      details: {
        originalCode: 'KB_CONFIG_INVALID',
        field: 'gatewayUrl',
        observedType: 'string',
        observedValuePreview: expect.stringContaining('[REDACTED]'),
      },
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      event: 'plugin.handler.failed',
      correlationId: 'diagnostic-contract-correlation',
      malformedField: 'gatewayUrl',
      malformedFieldType: 'string',
      malformedFieldPreview: expect.stringContaining('[REDACTED]'),
    });
    expect(JSON.stringify(envelope)).not.toContain(secret);
    expect(JSON.stringify(records[0])).not.toContain(secret);
    expect(String(envelope.details?.observedValuePreview).length).toBeLessThanOrEqual(256);
    expect(String(records[0]?.malformedFieldPreview).length).toBeLessThanOrEqual(256);
  });

  it.each([
    { pluginId: '@kb-labs/commit', command: 'commit plan show', hint: { key: 'errors.commit.open', params: { path: 'plan.json' } } },
    { pluginId: '@kb-labs/workflow', command: 'workflow defs list', hint: undefined },
    { pluginId: '@kb-labs/review', command: 'review run', hint: { message: 'Review failed', interpolation: { file: 'src/a.ts' } } },
  ])('keeps malformed hints attributable through the shared SDK failure helper for $command', ({ pluginId, command, hint }) => {
    const records: Array<Record<string, unknown>> = [];
    const returnedFailure = handleError(Object.assign(new Error(`${command} failed.`), {
      code: 'PLUGIN_COMMAND_FAILED',
      hint,
    }), 'sdk-helper-correlation');
    const envelope = normalizePluginHandlerFailure(returnedFailure.error, {
      pluginId,
      pluginVersion: '2.120.1',
      command,
      correlationId: 'sdk-helper-correlation',
      returnedFailure: true,
      returnedFailureError: returnedFailure.error,
      logger: loggerFor(records),
      logContext,
    });

    expect(envelope).toMatchObject({
      code: 'KB_PLUGIN_CONTRACT_VIOLATION',
      correlationId: 'sdk-helper-correlation',
      details: {
        field: 'hint',
        observedType: hint === undefined ? 'undefined' : 'object',
        sourceCode: returnedFailure.error.code,
        sourceErrorClass: 'Object',
        sourceMessage: returnedFailure.error.message,
        failureMode: 'returned',
      },
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      event: 'plugin.handler.failed',
      correlationId: 'sdk-helper-correlation',
      malformedField: 'hint',
      malformedFieldType: hint === undefined ? 'undefined' : 'object',
      sourceErrorClass: 'Object',
      sourceMessage: returnedFailure.error.message,
      failureMode: 'returned',
    });
  });

  it('retains redacted bounded source identity for a malformed error thrown by a handler', () => {
    const records: Array<Record<string, unknown>> = [];
    const secret = 'x105-source-message-secret';
    const logger = loggerFor(records);
    logger.registerSensitiveValues([secret]);
    const source = new Error(`provider failed ${secret}${'x'.repeat(400)}`);
    const envelope = normalizePluginHandlerFailure(source, {
      pluginId: '@kb-labs/test-plugin',
      pluginVersion: '2.122.1',
      command: 'provider invoke',
      correlationId: 'thrown-malformed-correlation',
      logger,
      logContext,
    });

    expect(envelope).toMatchObject({
      code: 'KB_PLUGIN_COMMAND_FAILED',
      details: {
        sourceErrorClass: 'Error',
        sourceMessage: expect.stringContaining('[REDACTED]'),
        failureMode: 'thrown',
      },
    });
    const sourceMessage = envelope.details?.sourceMessage;
    if (typeof sourceMessage !== 'string') throw new Error('source message must be a string');
    expect(sourceMessage.length).toBeLessThanOrEqual(256);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      event: 'plugin.handler.failed',
      pluginId: '@kb-labs/test-plugin',
      pluginVersion: '2.122.1',
      command: 'provider invoke',
      correlationId: 'thrown-malformed-correlation',
      sourceErrorClass: 'Error',
      sourceMessage: expect.stringContaining('[REDACTED]'),
      failureMode: 'thrown',
    });
    expect(JSON.stringify(envelope)).not.toContain(secret);
    expect(JSON.stringify(records[0])).not.toContain(secret);
  });

  it('reports the invalid field from the canonical envelope schema', () => {
    const fields = Object.keys(ErrorEnvelopeJsonSchema.properties);
    const base = createProductErrorEnvelope({
      code: 'MIND_INVALID', retryable: false, message: 'Invalid result.', hint: 'Correct the result.',
    });
    for (const field of fields) {
      const issues = validateErrorEnvelope({ ...base, [field]: null });
      expect(issues[0]?.field, field).toBe(field);
    }
    expect(validateErrorEnvelope({ ...base, unexpected: true })[0]).toMatchObject({
      field: 'unexpected',
    });
  });

  it('names every invalid envelope field derived from the canonical schema', () => {
      const records: Array<Record<string, unknown>> = [];
      const base = createProductErrorEnvelope({
        code: 'MIND_INVALID', retryable: false, message: 'Invalid result.', hint: 'Correct the result.',
      });
      const fields = Object.keys(ErrorEnvelopeJsonSchema.properties);
      const malformedByField: Array<{ field: string; malformed: Record<string, unknown> }> = fields.map((field) => ({
        field,
        malformed: { ...base, [field]: null },
      }));
      malformedByField.push({ field: 'unexpected', malformed: { ...base, unexpected: true } });
      for (const { field, malformed } of malformedByField) {
        expect(hasErrorEnvelopeIdentity(malformed), `identity for ${field}`).toBe(true);
        records.length = 0;
        const invalidField = validateErrorEnvelope(malformed)[0]?.field;
        expect(invalidField, field).toBe(field);
        const envelope = normalizePluginHandlerFailure(malformed, {
          pluginId: '@kb-labs/test-plugin', command: 'test run', correlationId: 'bad-field',
          pluginVersion: '1.0.0',
          logger: loggerFor(records), logContext,
        });
        expect(envelope).toMatchObject({
          code: 'KB_PLUGIN_CONTRACT_VIOLATION',
          message: expect.stringContaining(`field "${field}"`),
          details: { plugin: '@kb-labs/test-plugin', command: 'test run', field },
        });
        expect(records).toHaveLength(1);
      }
  });

  it('redacts configured secret values from the one correlated exception record', () => {
    const records: Array<Record<string, unknown>> = [];
    const secret = 'x46-redaction-fixture-value';
    const cause = new Error(`provider rejected ${secret}`, { cause: { token: secret } });
    const logger = loggerFor(records);
    logger.registerSensitiveValues([secret]);
    const envelope = normalizePluginHandlerFailure(cause, {
      pluginId: '@kb-labs/test-plugin',
      pluginVersion: '1.0.0',
      command: 'test run',
      correlationId: 'failure-correlation-1',
      logger,
      logContext,
    });

    expect(envelope.code).toBe('KB_PLUGIN_COMMAND_FAILED');
    expect(envelope.correlationId).toBe('failure-correlation-1');
    expect(records).toHaveLength(1);
    expect(JSON.stringify(envelope)).not.toContain(secret);
    expect(records[0]).toMatchObject({
      event: 'plugin.handler.failed',
      correlationId: 'failure-correlation-1',
      code: 'KB_PLUGIN_COMMAND_FAILED',
    });
    const serialized = JSON.stringify(records[0]);
    expect(serialized).not.toContain(secret);
    expect((records[0]!.error as Error).message).toContain('[REDACTED]');
    expect(records[0]!.serializedError).toMatchObject({
      name: 'Error',
      message: `provider rejected [REDACTED]`,
      cause: { name: 'NonErrorThrown', message: '[object Object]' },
    });
  });

  // case: S-203.25
  it('logs the returned typed failure message instead of the coerced object message', () => {
    const records: Array<Record<string, unknown>> = [];
    const returnedFailureError = {
      code: 'KB_RUNTIME_COMMAND_FAILED',
      message: 'Marketplace doctor found issues',
      hint: 'Run the marketplace doctor command again.',
    };
    const envelope = normalizePluginHandlerFailure(new Error('[object Object]'), {
      pluginId: '@kb-labs/marketplace',
      pluginVersion: '1.0.0',
      command: 'marketplace plugins doctor',
      correlationId: 'marketplace-doctor-correlation',
      returnedFailure: true,
      returnedFailureError,
      serializedError: { name: 'NonErrorThrown', message: '[object Object]' },
      logger: loggerFor(records),
      logContext,
    });

    expect(envelope.correlationId).toBe('marketplace-doctor-correlation');
    expect(records).toHaveLength(1);
    expect(records[0]?.serializedError).toMatchObject({ message: 'Marketplace doctor found issues' });
    expect(JSON.stringify(records[0])).not.toContain('[object Object]');
  });

  it('redacts process secrets from a typed envelope returned to the caller', () => {
    const records: Array<Record<string, unknown>> = [];
    const secret = 'x46-typed-envelope-secret-fixture';
    const logger = loggerFor(records);
    logger.registerSensitiveValues([secret]);
    const envelope = normalizePluginHandlerFailure(new ErrorEnvelopeError(createProductErrorEnvelope({
      code: 'MIND_NOT_FOUND', retryable: false,
      message: `Provider rejected ${secret}`,
      hint: 'Choose another mind.', details: { credential: secret },
    })), {
      pluginId: '@kb-labs/test-plugin', command: 'test run', correlationId: 'typed-secret-correlation',
      pluginVersion: '1.0.0',
      logger, logContext,
    });

    expect(records).toHaveLength(1);
    expect(JSON.stringify(envelope)).not.toContain(secret);
    expect(envelope.message).toContain('[REDACTED]');
    expect(envelope.details?.credential).toBe('[REDACTED]');
  });

  it('keeps the original thrown stack on its single correlated log record', () => {
    const records: Array<Record<string, unknown>> = [];
    const cause = new Error('handler diagnostic');
    cause.stack = 'original-handler-stack';
    normalizePluginHandlerFailure(cause, {
      pluginId: '@kb-labs/test-plugin', command: 'test run', correlationId: 'stack-correlation',
      pluginVersion: '1.0.0',
      logger: loggerFor(records), logContext,
    });
    expect(records).toHaveLength(1);
    expect((records[0]!.error as Error).stack).toBe('original-handler-stack');
  });

  it.each([
    [Object.assign(new Error('timeout'), { name: 'TimeoutError', code: 'TIMEOUT' }), 'timed out'],
    [Object.assign(new Error('worker crash'), { name: 'WorkerCrashedError', code: 'WORKER_CRASHED' }), 'execution process crashed'],
  ])('uses the shared failure code and names the reason', (error, reason) => {
    const records: Array<Record<string, unknown>> = [];
    const envelope = normalizePluginHandlerFailure(error, {
      pluginId: '@kb-labs/test-plugin',
      pluginVersion: '1.0.0',
      command: 'test run',
      correlationId: 'failure-correlation-2',
      logger: loggerFor(records),
      logContext,
    });
    expect(envelope.code).toBe('KB_PLUGIN_COMMAND_FAILED');
    expect(envelope.message).toContain(reason);
    expect(records).toHaveLength(1);
  });
});
