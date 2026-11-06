import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { catalogEnvironmentVariables } from './error-codes.generated.js';
import type { CatalogRuntimeTemplateParameters, CatalogTemplateParameters } from "./error-codes.generated.js";

import type { ErrorCode, ProductErrorCode } from './index.js';
import { AdapterConfigError, AdapterCredentialsMissingError, AdapterOperationError, AdapterProjectScopeError, AdapterUnavailableError, PlatformConfigError } from '../errors.js';
import { HostServiceAddressError } from '../host-service-address.js';
import { registerProcessSensitiveValues } from '../logging/context.js';
import {
  ERROR_AREAS,
  ERROR_STAGES,
  ErrorEnvelopeError,
  createErrorEnvelope,
  createCatalogErrorEnvelope,
  createUntrustedErrorEnvelope,
  decodeErrorEnvelope,
  errorCatalog,
  getCatalogEntry,
  isErrorCode,
  mapErrorEnvelopeToExitCode,
  renderTemplate,
  toErrorEnvelope,
  validateErrorEnvelope,
} from './index.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const fixtureDir = join(here, 'fixtures');

describe('structured diagnostic details', () => {
  it('keeps active-work items as JSON values and enforces their catalog shape', () => {
    const items = [{ kind: 'workflow', id: 'run-1', owningService: 'workflow' }];
    const envelope = createErrorEnvelope('KB_RESTART_WORK_IN_FLIGHT', {
      details: { interruptCommand: 'kb-create restart --platform-root /tmp/platform --interrupt', items },
    });
    expect(envelope.details?.items).toEqual(items);
    const invalid = decodeErrorEnvelope({
      ...envelope,
      details: { interruptCommand: 'kb-create restart --interrupt', items: [{ kind: 'workflow', id: 'run-1', owningService: 'workflow', extra: true }] },
    });
    expect(invalid.code).toBe('KB_RUNTIME_GATEWAY_PROTOCOL_FAILURE');
  });
});

describe('mapErrorEnvelopeToExitCode', () => {
  it('maps catalogued invalid input to usage exit and other envelopes to failure', () => {
    expect(mapErrorEnvelopeToExitCode('KB_RUNTIME_INPUT_INVALID')).toBe(2);
    expect(mapErrorEnvelopeToExitCode('KB_RUNTIME_UNEXPECTED')).toBe(1);
  });
});

describe('catalog producer contract', () => {
  it('does not require a runtime parameter for an overridden catalog hint', () => {
    expect(createErrorEnvelope('KB_RUNTIME_UNKNOWN_COMMAND', { hint: 'Use the command registry.' })).toMatchObject({
      code: 'KB_RUNTIME_UNKNOWN_COMMAND',
      hint: 'Use the command registry.',
    });
  });

  it('does not require parameters when both catalog templates are overridden', () => {
    expect(createErrorEnvelope('KB_RUNTIME_COMMAND_FAILED', {
      message: 'command failed',
      hint: 'Resolve the failure, then retry.',
    })).toMatchObject({
      code: 'KB_RUNTIME_COMMAND_FAILED',
      message: 'command failed',
      hint: 'Resolve the failure, then retry.',
    });
  });
});

describe('received catalog envelope reconstruction', () => {
  it('preserves the received cause when presenting a catalogued handler failure', () => {
    const received = createErrorEnvelope('KB_RUNTIME_COMMAND_FAILED', {
      message: 'Release build failed for 1 package(s).',
      hint: 'Inspect the failed packages and their build output, resolve the errors, then rerun `kb release build run`.',
      cause: '@kb-labs/studio-app:\nERROR in ./src/main.tsx\nModule not found',
    });

    const reconstructed = decodeErrorEnvelope(received, { presentation: 'handler' });

    expect(reconstructed.cause).toBe(received.cause);
  });

  // case: S-203.2
  it('preserves validated catalogued envelope fields and reports missing values as protocol failures', () => {
    const received = {
      ...createErrorEnvelope('KB_AUTH_FORBIDDEN', { details: { permission: 'plugins:manage' } }),
      message: 'Permission denied: plugins:manage',
      hint: 'Ask your administrator for the permission needed to perform this operation.',
    };
    const reconstructed = decodeErrorEnvelope(received);
    expect(reconstructed).toMatchObject({
      code: 'KB_AUTH_FORBIDDEN',
      message: 'Permission denied: plugins:manage',
      hint: 'Ask your administrator for the permission needed to perform this operation.',
      details: { permission: 'plugins:manage' },
    });
    expect(JSON.stringify(reconstructed)).not.toContain('remote ');

    const missing = decodeErrorEnvelope({ ...received, details: {} });
    expect(missing).toMatchObject({
      code: 'KB_RUNTIME_GATEWAY_PROTOCOL_FAILURE',
      details: { remoteCode: 'KB_AUTH_FORBIDDEN', fields: 'permission' },
    });

    const undeclared = decodeErrorEnvelope({
      ...received,
      message: 'untrusted remote prose',
      hint: 'untrusted remote hint',
      details: { permission: 'plugins:manage', undeclaredRemoteField: 'value' },
    });
    expect(undeclared).toMatchObject({
      code: 'KB_RUNTIME_GATEWAY_PROTOCOL_FAILURE',
      details: { remoteCode: 'KB_AUTH_FORBIDDEN', fields: 'undeclaredRemoteField' },
    });
    expect(JSON.stringify(undeclared)).not.toContain('untrusted remote');

    const withSafeDetail = decodeErrorEnvelope({
      ...createErrorEnvelope('KB_AUTH_SESSION_REVOKED', { details: { gatewayUrl: 'https://gateway.test' } }),
      message: 'remote message',
      hint: 'remote hint',
      details: { gatewayUrl: 'https://gateway.test', reason: 'revoked' },
    });
    expect(withSafeDetail).toMatchObject({
      code: 'KB_AUTH_SESSION_REVOKED',
      details: { gatewayUrl: 'https://gateway.test', reason: 'revoked' },
    });
    expect(withSafeDetail).not.toMatchObject({ message: 'remote message', hint: 'remote hint' });
  });

  it('preserves validated diagnostic findings while rebuilding the received envelope', () => {
    const received = {
      ...createErrorEnvelope('KB_RUNTIME_INPUT_INVALID', {
        message: 'QA case coverage input is invalid',
        hint: 'Fix the listed case coverage inputs, then rerun `kb qa coverage show`.',
        diagnostics: [{
          code: 'KB_QA_CASE_COVERAGE_INPUT_INVALID',
          message: 'claims[2].status must be PASS or FAIL',
          severity: 'error' as const,
          path: 'corrupted-run.json',
        }],
      }),
    };

    const reconstructed = decodeErrorEnvelope(received, { presentation: 'handler' });

    expect(reconstructed.code).toBe('KB_RUNTIME_INPUT_INVALID');
    expect(reconstructed.message).toBe('QA case coverage input is invalid');
    expect(reconstructed.hint).toBe('Fix the listed case coverage inputs, then rerun `kb qa coverage show`.');
    expect(reconstructed.diagnostics).toEqual(received.diagnostics);
  });
});

describe('correlation-aware catalog hints', () => {
  it('uses a no-correlation hint variant when the error has no correlation ID', () => {
    const envelope = createErrorEnvelope('KB_PLUGIN_COMMAND_FAILED', {
      details: { command: 'test run', plugin: '@kb-labs/test-plugin', failureReason: 'failed unexpectedly' },
    });

    expect(envelope.hint).toBe('Run `kb logs query` to inspect the failure details and stack, then fix the reported plugin issue.');
    expect(envelope.hint).not.toContain('unknown');
  });

  it('uses the timeout no-correlation hint variant when no ID is available', () => {
    const envelope = createErrorEnvelope('KB_RUNTIME_TIMEOUT');

    expect(envelope.hint).toBe('Run `kb logs query` to inspect the timeout, then retry or increase the timeout.');
    expect(envelope.hint).not.toContain('unknown');
  });
});

function loadFixtures(kind: 'valid' | 'invalid'): Array<{ name: string; value: unknown }> {
  const dir = join(fixtureDir, kind);
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => ({ name: file, value: JSON.parse(readFileSync(join(dir, file), 'utf8')) as unknown }));
}

describe('errors.catalog.json lint', () => {
  it('keeps the generated code type in sync with the sole catalog', () => {
    const generatedPath = new URL('./error-codes.generated.ts', import.meta.url);
    const generated = readFileSync(generatedPath, 'utf8');
    const codes = [...generated.matchAll(/^  \| "([^"]+)"$/gm)].map((match) => match[1]);
    expect(codes).toEqual(errorCatalog.codes.map((entry) => entry.code).sort());
    expectTypeOf<ErrorCode>().not.toEqualTypeOf<string>();
    expectTypeOf<'KB_RUNTIME_COMMAND_FAILED'>().toMatchTypeOf<ErrorCode>();
    expectTypeOf<'KB_RUNTIME_UNKNOWN_COMMAND'>().toMatchTypeOf<ErrorCode>();
    expectTypeOf<CatalogTemplateParameters['KB_RUNTIME_UNKNOWN_COMMAND']>().toEqualTypeOf<{ binary: string }>();
    expectTypeOf<CatalogRuntimeTemplateParameters['KB_RUNTIME_UNKNOWN_COMMAND']>().toEqualTypeOf<{ binary: string }>();
    expectTypeOf<'NOT_CATALOGUED_CODE'>().not.toMatchTypeOf<ErrorCode>();
    expectTypeOf<ProductErrorCode>().toMatchTypeOf<ErrorCode>();
    expectTypeOf<'KB_TYPO'>().not.toMatchTypeOf<ErrorCode>();
  });

  it('keeps generated environment names synchronized with the shared catalogue', () => {
    expect(Object.values(catalogEnvironmentVariables).sort()).toEqual([...errorCatalog.environmentVariables].sort());
  });

  it('has unique codes', () => {
    const codes = errorCatalog.codes.map((entry) => entry.code);
    expect(codes.filter((code, index) => codes.indexOf(code) !== index)).toEqual([]);
  });

  it('gives every code a non-empty message and hint', () => {
    for (const entry of errorCatalog.codes) {
      expect(entry.message.trim(), `${entry.code} message`).not.toBe('');
      expect(entry.hint.trim(), `${entry.code} hint`).not.toBe('');
    }
  });

  it('declares one Go CLI exit class for every catalog code', () => {
    for (const entry of errorCatalog.codes) {
      expect(['input-refusal', 'operation-failure'], `${entry.code} processExitClass`)
        .toContain(entry.processExitClass);
    }
  });

  // case: S-203.2
  it('declares a transport status for every catalog code', () => {
    for (const entry of errorCatalog.codes) {
      expect(entry.httpStatus, `${entry.code} httpStatus`).toBeTypeOf('number');
      expect(entry.httpStatus, `${entry.code} httpStatus`).toBeGreaterThanOrEqual(100);
      expect(entry.httpStatus, `${entry.code} httpStatus`).toBeLessThanOrEqual(599);
    }
  });

  it('assigns compatibility refusal its input refusal exit class', () => {
    expect(getCatalogEntry('KB_INSTALL_INCOMPATIBLE_COMPONENTS')).toMatchObject({
      processExitClass: 'input-refusal',
      httpStatus: 409,
    });
  });

  it('catalogues the transport outcomes for the recorded HTTP failures', () => {
    expect(getCatalogEntry('KB_CONFIG_LLM_KEY_INVALID')?.httpStatus).toBe(502);
    expect(getCatalogEntry('KB_RUNTIME_DIAGNOSTIC_CONTRACT_VIOLATION')?.httpStatus).toBe(500);
    expect(getCatalogEntry('KB_INSTALL_PROVENANCE_MISMATCH')?.structuredDetailFields)
      .toEqual(expect.arrayContaining(['diagnosticPath', 'logPath']));
  });


  it('renders the unexpected-error log query from the envelope correlation ID', () => {
    const envelope = createErrorEnvelope('KB_RUNTIME_UNEXPECTED', { correlationId: 'cli-correlation-1' });

    expect(envelope.hint).toBe('Run \"kb logs query --correlation-id cli-correlation-1\" to inspect the failure details and stack.');
    expect(envelope.details).toBeUndefined();
  });

  it('defines the shared CLI command failure code', () => {
    expect(getCatalogEntry('KB_RUNTIME_COMMAND_FAILED')).toMatchObject({
      area: 'runtime',
      stage: 'run',
      message: 'The command could not complete.',
    });
  });

  it('narrows untrusted codes through the catalog guard', () => {
    expect(isErrorCode('KB_RUNTIME_COMMAND_FAILED')).toBe(true);
    expect(isErrorCode('KB_PERMISSION_DENIED')).toBe(false);
  });

  // case: S-243.5
  it('defines the HTTP status for a project runtime timeout', () => {
    expect(getCatalogEntry('KB_RUNTIME_TIMEOUT')).toMatchObject({
      httpStatus: 504,
      hint: 'Run \"kb logs query --correlation-id {correlationId}\" to inspect the timeout, then retry or increase the timeout.',
    });
  });

  it('keeps installer index errors separate from publisher sealing errors', () => {
    expect(getCatalogEntry('KB_INSTALL_RELEASE_INDEX_INVALID')).toMatchObject({
      area: 'install',
      retryable: true,
      hint: 'Retry the command; if it persists report the correlationId (this is a KB Labs problem).',
    });
    expect(getCatalogEntry('KB_RELEASE_INDEX_SEAL_FAILED')).toMatchObject({
      area: 'release',
      retryable: false,
      hint: 'Fix the release inputs named in the cause, then rerun release-index preparation.',
    });
  });

  it('keeps catalog entries within the supported areas', () => {
    for (const entry of errorCatalog.codes) {
      expect(ERROR_AREAS as readonly string[], entry.code).toContain(entry.area);
    }
  });

  it('uses only stages from the documented journey vocabulary', () => {
    for (const entry of errorCatalog.codes) {
      expect(ERROR_STAGES as readonly string[], entry.code).toContain(entry.stage);
    }
  });

  it('renders every entry into a valid envelope with no unresolved placeholders', () => {
    for (const entry of errorCatalog.codes) {
      const placeholders = [...`${entry.message} ${entry.hint}`.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map(
        (match) => match[1] ?? '',
      );
      const details = Object.fromEntries(placeholders.map((name) => [name, `<${name}>`]));
      const envelope = createErrorEnvelope(entry.code, { details });
      expect(validateErrorEnvelope(envelope), entry.code).toEqual([]);
      expect(envelope.message).not.toContain('{');
      expect(envelope.hint).not.toContain('{');
    }
  });

  it('keeps the launcher error codes that the Go side emits', () => {
    for (const code of [
      'KB_INSTALL_INCOMPATIBLE_COMPONENTS',
      'KB_INSTALL_PROVIDER_UNRESOLVED',
      'KB_INSTALL_PROVIDER_AMBIGUOUS',
      'KB_INSTALL_INPUT_REQUIRED',
      'KB_INSTALL_CONFIG_REQUIRED',
      'KB_INSTALL_ARTIFACT_MANIFEST_MISMATCH',
      'KB_INSTALL_SERVICE_GRAPH_MISMATCH',
    ]) {
      expect(isErrorCode(code), code).toBe(true);
      if (isErrorCode(code)) expect(getCatalogEntry(code), code).toBeDefined();
    }
    expect(errorCatalog.codes.some((entry) => entry.code.startsWith('KB_CREATE_'))).toBe(false);
  });
});

describe('shared envelope fixtures', () => {
  for (const { name, value } of loadFixtures('valid')) {
    it(`accepts valid/${name}`, () => {
      expect(validateErrorEnvelope(value)).toEqual([]);
    });
  }
  for (const { name, value } of loadFixtures('invalid')) {
    it(`rejects invalid/${name}`, () => {
      expect(validateErrorEnvelope(value).length).toBeGreaterThan(0);
    });
  }
});

describe('renderTemplate', () => {
  it('substitutes declared template names and preserves other braces literally', () => {
    expect(renderTemplate('Port {port} in {where}', { port: '4000' }, ['port']))
      .toBe('Port 4000 in {where}');
  });
});

describe('createErrorEnvelope', () => {
  it('keeps input-invalid hints binary-agnostic outside CLI invocation handling', () => {
    const envelope = createErrorEnvelope('KB_RUNTIME_INPUT_INVALID');
    expect(envelope.hint).not.toContain('--help');
    expect(envelope.hint).not.toContain('{binary}');
  });

  it('requires and renders the invocation binary for unknown commands', () => {
    const envelope = createErrorEnvelope('KB_RUNTIME_UNKNOWN_COMMAND', {
      templateValues: { binary: 'test-cli' },
    });
    expect(envelope.hint).toContain('test-cli --help');
    expect(envelope.code).toBe('KB_RUNTIME_UNKNOWN_COMMAND');
  });

  it('omits a cause that repeats the resolved message', () => {
    const envelope = createErrorEnvelope('KB_ADAPTER_NOT_INSTALLED', {
      details: { package: '@kb-labs/not-installed' },
      cause: 'Adapter package @kb-labs/not-installed is not installed on this platform.',
    });

    expect(envelope).toMatchObject({
      code: 'KB_ADAPTER_NOT_INSTALLED',
      message: 'Adapter package @kb-labs/not-installed is not installed on this platform.',
    });
    expect(envelope).not.toHaveProperty('cause');
  });

  it('preserves braces inside dynamic values and free-form hints literally', () => {
    const envelope = createErrorEnvelope('KB_ADAPTER_NOT_INSTALLED', {
      details: { package: '@kb-labs/example/{braces}' },
      hint: 'Inspect the literal {braces} before retrying.',
    });
    expect(envelope.message).toContain('@kb-labs/example/{braces}');
    expect(envelope.hint).toBe('Inspect the literal {braces} before retrying.');
  });

  it('returns a catalogued producer-contract diagnostic for undeclared details', () => {
    const envelope = createUntrustedErrorEnvelope('KB_RUNTIME_UNEXPECTED', {
      details: { undeclaredEvidence: 'unexpected' },
    });
    expect(envelope.code).toBe('KB_RUNTIME_DIAGNOSTIC_CONTRACT_VIOLATION');
    expect(envelope.details).toMatchObject({
      originalCode: 'KB_RUNTIME_UNEXPECTED',
      fields: 'undeclaredEvidence',
      field: 'undeclaredEvidence',
      observedType: 'string',
      observedValuePreview: "'unexpected'",
    });
  });

  it('retains a cause that adds information beyond the message', () => {
    const envelope = createErrorEnvelope('KB_ADAPTER_NOT_INSTALLED', {
      details: { package: '@kb-labs/not-installed' },
      cause: 'The package is missing from platform node_modules.',
    });

    expect(envelope.cause).toBe('The package is missing from platform node_modules.');
  });
});

describe('structured error diagnostics', () => {
  it('renders invocation-owned binary values in catalog hints without exposing them as details', () => {
    const envelope = createErrorEnvelope('KB_RUNTIME_COMMAND_FAILED', {
      templateValues: { binary: 'test-cli' },
    });

    expect(envelope.hint).toContain('test-cli --help');
    expect(envelope.hint).not.toMatch(/[{}]/);
    expect(envelope).not.toHaveProperty('details');
  });

  it('keeps validation failures binary-agnostic', () => {
    const envelope = toErrorEnvelope(Object.assign(new Error('Invalid input.'), {
      validation: [{ path: 'value', message: 'must be valid' }],
    }));

    expect(envelope.code).toBe('KB_RUNTIME_INPUT_INVALID');
    expect(envelope.hint).not.toContain('--help');
    expect(envelope.hint).not.toMatch(/[{}]/);
  });

  it('keeps gate findings as typed diagnostics', () => {
    const envelope = createErrorEnvelope('KB_RUNTIME_COMMAND_FAILED', {
      templateValues: { binary: 'test-cli' },
      diagnostics: [{ code: 'CONFIG_INVALID', message: 'Invalid setting.', severity: 'error', path: 'config.json', line: 3, hint: 'Fix the setting.' }],
    });
    expect(envelope.diagnostics).toEqual([{ code: 'CONFIG_INVALID', message: 'Invalid setting.', severity: 'error', path: 'config.json', line: 3, hint: 'Fix the setting.' }]);
    expect(validateErrorEnvelope(envelope)).toEqual([]);
  });

  it.each(['{"findings":[]}', '[{"message":"bad"}]'])('rejects serialized structured detail values: %s', (value) => {
    try {
      createUntrustedErrorEnvelope('KB_RUNTIME_COMMAND_FAILED', { templateValues: { binary: 'test-cli' }, details: { report: value } });
      throw new Error('expected serialized JSON detail to be rejected');
    } catch (error) {
      expect(error).toMatchObject({ code: 'KB_PLUGIN_CONTRACT_VIOLATION', hint: expect.stringContaining('error.diagnostics') });
    }
  });

  it.each(['{"findings":[]}', '[{"message":"bad"}]'])('rejects serialized structured details during envelope validation: %s', (value) => {
    const envelope = createErrorEnvelope('KB_RUNTIME_COMMAND_FAILED', { templateValues: { binary: 'test-cli' } });
    expect(validateErrorEnvelope({ ...envelope, details: { report: value } })).toContainEqual({
      field: 'details.report',
      reason: 'must not contain serialized JSON; use data or diagnostics',
    });
  });

  it('rejects non-string details in the builder with a catalogued contract violation', () => {
    expect(() => createUntrustedErrorEnvelope('KB_RUNTIME_COMMAND_FAILED', {
      templateValues: { binary: 'test-cli' },
      details: { report: ['finding'] },
    })).toThrow(expect.objectContaining({ code: 'KB_PLUGIN_CONTRACT_VIOLATION' }));
  });
});

describe('toErrorEnvelope (platform errors)', () => {
  it('retains agent session IDs in catalogued resource not-found details', () => {
    const error = Object.assign(
      new Error('session-does-not-exist'),
      {
        errorCode: 'KB_RUNTIME_RESOURCE_NOT_FOUND',
        details: { plugin: '@kb-labs/agents', sessionId: 'session-does-not-exist' },
      },
    );

    expect(toErrorEnvelope(error)).toMatchObject({
      code: 'KB_RUNTIME_RESOURCE_NOT_FOUND',
      details: { plugin: '@kb-labs/agents', sessionId: 'session-does-not-exist' },
      cause: expect.stringContaining('session-does-not-exist'),
    });
  });

  it('maps an unknown agent ID to its registered plugin 404 envelope', () => {
    const error = Object.assign(
      new Error('agent-not-found-test'),
      { errorCode: 'KB_AGENT_NOT_FOUND', details: { agentId: 'agent-does-not-exist' } },
    );

    const envelope = toErrorEnvelope(error);
    expect(envelope).toMatchObject({
      code: 'KB_AGENT_NOT_FOUND',
      area: 'plugin',
      message: expect.stringContaining('agent-does-not-exist'),
      details: { agentId: 'agent-does-not-exist' },
    });
    expect(envelope.hint).toBe(getCatalogEntry('KB_AGENT_NOT_FOUND')?.hint);
    expect(getCatalogEntry('KB_AGENT_NOT_FOUND')?.httpStatus).toBe(404);
  });

  it('does not promote a catalogued error message into a duplicate cause', () => {
    const message = 'Adapter package @kb-labs/not-installed is not installed on this platform.';
    const error = Object.assign(new Error(message), { code: 'KB_ADAPTER_NOT_INSTALLED', details: { package: '@kb-labs/not-installed' } });

    const envelope = toErrorEnvelope(error);

    expect(envelope).toMatchObject({ code: 'KB_ADAPTER_NOT_INSTALLED', message });
    expect(envelope).not.toHaveProperty('cause');
  });

  it('preserves a typed catalogued envelope thrown through the platform boundary', () => {
    const envelope = createErrorEnvelope('KB_AUTH_TOKEN_EXPIRED', {
      details: { gatewayUrl: 'https://gateway.test', reason: 'expired' },
      correlationId: 'auth-correlation',
    });
    expect(toErrorEnvelope(new ErrorEnvelopeError(envelope))).toEqual(envelope);
  });

  // case: S-191.7
  it('maps invalid adapter options to an actionable KB_CONFIG_INVALID envelope', () => {
    const envelope = toErrorEnvelope(new AdapterConfigError(
      'platform.adapterOptions.analytics.retentionDays',
      'must be a positive integer',
      'kb config set --scope platform platform.adapterOptions.analytics.retentionDays 90',
    ));

    expect(envelope).toMatchObject({
      code: 'KB_CONFIG_INVALID',
      message: 'Adapter option "platform.adapterOptions.analytics.retentionDays" is invalid: must be a positive integer.',
      hint: 'kb config set --scope platform platform.adapterOptions.analytics.retentionDays 90',
      details: { path: 'platform.adapterOptions.analytics.retentionDays' },
      cause: 'must be a positive integer',
    });
    expect(validateErrorEnvelope(envelope)).toEqual([]);
  });

  it('maps platform config load failures to actionable KB_CONFIG_INVALID envelopes', () => {
    const error = new PlatformConfigError('/tmp/platform/.kb/kb.config.json', 'parse', 'Unexpected token');
    const envelope = toErrorEnvelope(error);

    expect(envelope).toMatchObject({
      code: 'KB_CONFIG_INVALID',
      message: 'Platform configuration file "/tmp/platform/.kb/kb.config.json" contains invalid JSON.',
      hint: 'Run python3 -m json.tool "/tmp/platform/.kb/kb.config.json" to locate the syntax error, fix the file, then retry the CLI command.',
      details: { path: '/tmp/platform/.kb/kb.config.json' },
      cause: 'Unexpected token',
    });
    expect(validateErrorEnvelope(envelope)).toEqual([]);
  });

  it('gives a concrete inspection command for structurally invalid config', () => {
    const envelope = toErrorEnvelope(new PlatformConfigError(
      '/tmp/platform/.kb/kb.config.json', 'invalid', 'platform.adapters must be an object',
    ));

    expect(envelope.code).toBe('KB_CONFIG_INVALID');
    expect(envelope.cause).toBe('platform.adapters must be an object');
    expect(envelope.hint).toContain('Run sed -n \'1,200p\' "/tmp/platform/.kb/kb.config.json"');
    expect(validateErrorEnvelope(envelope)).toEqual([]);
  });

  it('maps project adapter configuration to an actionable scope error', () => {
    const envelope = toErrorEnvelope(new AdapterProjectScopeError());
    expect(validateErrorEnvelope(envelope)).toEqual([]);
    expect(envelope.code).toBe('KB_ADAPTER_PROJECT_SCOPE');
    expect(envelope.message).toContain('Project adapter configuration');
    expect(envelope.hint).toContain('Move `platform.adapters` and `platform.adapterOptions` to the platform config');
  });

  // case: S-054.8
  it('maps a bound adapter missing credentials to an actionable credential envelope', () => {
    const envelope = toErrorEnvelope(new AdapterCredentialsMissingError(
      'llm', 'OPENAI_API_KEY', 'platform.adapterOptions.llm.apiKey',
    ));
    expect(validateErrorEnvelope(envelope)).toEqual([]);
    expect(envelope.code).toBe('KB_ADAPTER_CREDENTIALS_MISSING');
    expect(envelope.message).toContain('OPENAI_API_KEY');
    expect(envelope.hint).toContain("kb config set --scope platform platform.adapterOptions.llm.apiKey '${OPENAI_API_KEY}' --allow-missing-env");
    expect(envelope.hint).toContain('No request was sent');
  });

  it('maps a not-configured adapter to KB_ADAPTER_NOT_CONFIGURED', () => {
    const envelope = toErrorEnvelope(new AdapterUnavailableError('llm'), { correlationId: 'c1' });
    expect(validateErrorEnvelope(envelope)).toEqual([]);
    expect(envelope.code).toBe('KB_ADAPTER_NOT_CONFIGURED');
    expect(envelope.details).toEqual({
      service: 'llm',
      adapter: 'platform.adapters.llm',
      command: 'kb adapter bind llm @kb-labs/adapters-openai',
    });
    expect(envelope.correlationId).toBe('c1');
    expect(envelope.hint).toContain('kb adapter bind llm @kb-labs/adapters-openai');
    expect(envelope.actions?.[0]?.command).toBe(
      'kb adapter bind llm @kb-labs/adapters-openai',
    );
  });

  it('normalizes typed platform errors structurally when they cross a package boundary', () => {
    const error = Object.assign(new Error('Adapter "llm" is not available.'), {
      code: 'KB_ADAPTER_NOT_CONFIGURED',
      details: { service: 'llm', adapter: 'platform.adapters.llm', command: 'kb adapter bind llm @kb-labs/adapters-openai' },
    });

    expect(toErrorEnvelope(error)).toMatchObject({
      code: 'KB_ADAPTER_NOT_CONFIGURED',
      message: 'Adapter "llm" is not available.',
      details: { service: 'llm' },
    });
  });

  // case: S-211.4
  it('maps exhausted adapter operations to a catalogued actionable failure', () => {
    const envelope = toErrorEnvelope(new AdapterOperationError(
      'cache',
      'get',
      'Redis cache operation failed.',
      new Error('connection lost'),
    ));

    expect(envelope).toMatchObject({
      code: 'KB_ADAPTER_OPERATION_FAILED',
      message: 'The cache adapter failed during get.',
      hint: expect.stringContaining('kb logs query'),
      details: { slot: 'cache', operation: 'get' },
    });
  });

  it('maps a missing vector store to a bind action for that capability', () => {
    const envelope = toErrorEnvelope(new AdapterUnavailableError('vectorStore'));
    expect(validateErrorEnvelope(envelope)).toEqual([]);
    expect(envelope.code).toBe('KB_ADAPTER_NOT_CONFIGURED');
    expect(envelope.details?.service).toBe('vectorStore');
    expect(envelope.actions?.[0]?.command).toMatch(/^kb adapter bind vectorStore /);
    expect(envelope.hint).toContain('kb adapter bind vectorStore');
  });

  it('maps a load-failed adapter to KB_HOST_ADAPTER_UNAVAILABLE', () => {
    const envelope = toErrorEnvelope(new AdapterUnavailableError('cache', 'load-failed'));
    expect(envelope.code).toBe('KB_HOST_ADAPTER_UNAVAILABLE');
    expect(envelope.retryable).toBe(true);
    expect(envelope.details).toEqual({ slot: 'cache', reason: 'load-failed' });
  });

  // case: S-179.6
  it('preserves the workspace adapter build hint and command on a typed startup error', () => {
    const envelope = toErrorEnvelope(new AdapterUnavailableError(
      'storage',
      'load-failed',
      'The configured workspace adapter is not built.',
      undefined,
      {
        userMessage: 'Workspace adapter package "@kb-labs/adapters-fs" has not been built.',
        hint: 'Build the workspace adapter packages, then retry the command.',
        action: {
          id: 'build-workspace-adapters',
          label: 'Build workspace adapters',
          command: 'pnpm build',
        },
      },
    ));
    expect(validateErrorEnvelope(envelope)).toEqual([]);
    expect(envelope.code).toBe('KB_HOST_ADAPTER_UNAVAILABLE');
    expect(envelope.message).toBe('Workspace adapter package "@kb-labs/adapters-fs" has not been built.');
    expect(envelope.hint).toBe('Build the workspace adapter packages, then retry the command.');
    expect(envelope.actions?.[0]?.command).toBe('pnpm build');
  });

  it('wraps unknown values as KB_RUNTIME_UNEXPECTED', () => {
    const envelope = toErrorEnvelope('boom');
    expect(envelope.code).toBe('KB_RUNTIME_UNEXPECTED');
    expect(envelope.cause).toBe('boom');
    expect(envelope.correlationId).toEqual(expect.any(String));
  });

  it('does not manufacture an envelope code from an uncatalogued plugin error', () => {
    const error = Object.assign(new Error('ClickUp refused access.'), { code: 'KB_PERMISSION_DENIED' });

    expect(toErrorEnvelope(error)).toMatchObject({
      code: 'KB_PLUGIN_CONTRACT_VIOLATION',
    });
  });

  it('preserves contract-valid product codes and rejects a missing hint', () => {
    const productError = Object.assign(new Error('Nothing is staged.'), {
      code: 'COMMIT_NOTHING_STAGED',
      hint: 'Stage the intended changes, then retry.',
      details: { repository: 'workspace' },
    });

    expect(toErrorEnvelope(productError)).toMatchObject({
      code: 'COMMIT_NOTHING_STAGED',
      area: 'product',
      message: 'Nothing is staged.',
      hint: 'Stage the intended changes, then retry.',
      details: { repository: 'workspace' },
    });
    expect(toErrorEnvelope(Object.assign(new Error('No hint.'), {
      code: 'COMMIT_NOTHING_STAGED',
    })).code).toBe('KB_PLUGIN_CONTRACT_VIOLATION');
  });

  it('keeps catalogued thrown error fields and converts malformed details to a contract violation', () => {
    const catalogued = Object.assign(new Error('Invalid input.'), {
      code: 'KB_RUNTIME_INPUT_INVALID',
      hint: 'Fix the input.',
      details: { field: 'name' },
      correlationId: 'catalogued-correlation',
    });
    expect(toErrorEnvelope(catalogued)).toMatchObject({
      code: 'KB_RUNTIME_INPUT_INVALID',
      message: 'Invalid input.',
      hint: 'Fix the input.',
      details: { field: 'name' },
      correlationId: 'catalogued-correlation',
    });

    const malformed = Object.assign(new Error('Bad details.'), {
      code: 'KB_RUNTIME_COMMAND_FAILED',
      details: { report: 17 },
    });
    expect(toErrorEnvelope(malformed)).toMatchObject({
      code: 'KB_PLUGIN_CONTRACT_VIOLATION',
      hint: expect.stringContaining('error.diagnostics'),
    });
  });

  it('keeps the observed product hint shape when a thrown error has a malformed hint', () => {
    const objectHint = { key: 'errors.review.failed', params: { file: 'src/a.ts' } };
    const malformed = Object.assign(new Error('Review failed.'), {
      code: 'REVIEW_FAILED',
      hint: objectHint,
    });

    expect(toErrorEnvelope(malformed, { correlationId: 'malformed-product-hint' })).toMatchObject({
      code: 'KB_PLUGIN_CONTRACT_VIOLATION',
      correlationId: 'malformed-product-hint',
      details: {
        field: 'hint',
        observedType: 'object',
        observedValuePreview: expect.stringContaining('errors.review.failed'),
      },
    });
    expect(toErrorEnvelope(Object.assign(new Error('Missing hint.'), { code: 'REVIEW_FAILED' }))).toMatchObject({
      code: 'KB_PLUGIN_CONTRACT_VIOLATION',
      details: { field: 'hint', observedType: 'undefined', observedValuePreview: 'undefined' },
    });
  });

  it('redacts registered secrets in malformed field keys and values before bounding the preview', () => {
    const secret = 'x81-round6-malformed-secret-value';
    registerProcessSensitiveValues([secret]);
    const malformed = Object.assign(new Error('Review failed.'), {
      code: 'REVIEW_FAILED',
      hint: {
        [secret]: secret,
        nested: { password: secret },
        tail: 'x'.repeat(400),
      },
    });

    const envelope = toErrorEnvelope(malformed);
    const preview = envelope.details?.observedValuePreview ?? '';

    expect(envelope.details).toMatchObject({ field: 'hint', observedType: 'object' });
    expect(preview).toContain('[REDACTED]');
    expect(preview).not.toContain(secret);
    expect(typeof preview).toBe('string');
    expect((preview as string).length).toBeLessThanOrEqual(256);
  });

  // case: S-054.19
  it('maps a missing host gateway address to its catalog code and preserves correlation', () => {
    const envelope = toErrorEnvelope(
      new HostServiceAddressError('gateway'),
      { correlationId: 'corr-workflow' },
    );
    expect(envelope).toMatchObject({
      code: 'KB_HOST_SERVICE_ADDRESS_MISSING',
      details: { service: 'gateway' },
      correlationId: 'corr-workflow',
      hint: 'Start the host with kb-create start so it can pass live host service addresses to this runtime.',
    });
    expect(validateErrorEnvelope(envelope)).toEqual([]);
  });

  it('rejects invalid details on validation-shaped errors instead of silently dropping them', () => {
    const malformed = Object.assign(new Error('Invalid input.'), {
      code: 'KB_RUNTIME_INPUT_INVALID',
      issues: [{ path: 'field', message: 'Required' }],
      details: { field: { nested: true } },
    });
    expect(toErrorEnvelope(malformed)).toMatchObject({
      code: 'KB_PLUGIN_CONTRACT_VIOLATION',
      hint: expect.stringContaining('error.diagnostics'),
    });
  });

  it('catalogues an installed adapter that does not declare the requested slot', () => {
    const envelope = createErrorEnvelope('KB_ADAPTER_SLOT_MISMATCH', {
      details: { package: '@kb-labs/adapters-storage-fixture', slot: 'llm' },
    });
    expect(envelope).toMatchObject({
      code: 'KB_ADAPTER_SLOT_MISMATCH',
      message: 'Adapter package @kb-labs/adapters-storage-fixture does not declare platform slot llm.',
      hint: 'Install a provider that declares llm with `kb marketplace install <pkg> --scope platform`, then retry.',
    });
    expect(validateErrorEnvelope(envelope)).toEqual([]);
  });

  it('rejects codes that are not in the catalog', () => {
    expect(isErrorCode('KB_NOPE_NOPE')).toBe(false);
  });
});


it('constructs a command diagnostic with its catalogued runtime template', () => {
  const envelope = createCatalogErrorEnvelope({ code: 'KB_RUNTIME_COMMAND_FAILED', templateValues: { binary: 'kb' } });
  expect(envelope.code).toBe('KB_RUNTIME_COMMAND_FAILED');
  expect(envelope.hint).toContain('kb');
});

it('validates required runtime parameters and honors catalog overrides', () => {
  // @ts-expect-error This deliberately exercises runtime validation of an invalid producer request.
  const missing = createCatalogErrorEnvelope({ code: 'KB_RUNTIME_COMMAND_FAILED' });
  expect(missing.code).toBe('KB_RUNTIME_DIAGNOSTIC_CONTRACT_VIOLATION');
  const overridden = createCatalogErrorEnvelope({ code: 'KB_RUNTIME_COMMAND_FAILED', hint: 'Retry the command.' });
  expect(overridden.code).toBe('KB_RUNTIME_COMMAND_FAILED');
  expect(overridden.hint).toBe('Retry the command.');
});
