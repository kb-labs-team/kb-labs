import { describe, expect, it } from 'vitest';
import { AdapterUnavailableError, toErrorEnvelope, validateErrorEnvelope } from '@kb-labs/core-platform';
import { PluginError } from '@kb-labs/plugin-contracts';
import { defineError } from '../errors/index';
import { ServiceNotConfiguredError } from '../helpers/platform';
import { ValidationError } from '../helpers/validation';

describe('core toErrorEnvelope for command-kit errors', () => {
  it('preserves a valid defineError product code and its required hint', () => {
    const MindError = defineError('MIND', {
      IndexNotFound: {
        code: 404,
        message: (scope: string) => `Index '${scope}' not found`,
        hint: 'Check the index name and confirm it exists before retrying.',
      },
      Timeout: {
        code: 504,
        message: 'Query timed out',
        hint: 'Retry the query; if it continues to time out, inspect the service logs.',
      },
    });

    const notFound = toErrorEnvelope(new MindError.IndexNotFound('default'), { correlationId: 'c1' });
    expect(validateErrorEnvelope(notFound)).toEqual([]);
    expect(notFound).toMatchObject({
      code: 'MIND_INDEXNOTFOUND',
      area: 'product',
      severity: 'error',
      retryable: false,
      message: "Index 'default' not found",
      hint: 'Check the index name and confirm it exists before retrying.',
      correlationId: 'c1',
    });

    const timeout = toErrorEnvelope(new MindError.Timeout());
    expect(timeout.code).toBe('MIND_TIMEOUT');
    expect(timeout.hint).toContain('Retry the query');
  });

  it('rejects structured PluginError details with a catalogued contract violation', () => {
    const InvalidError = defineError('MIND', {
      Invalid: { code: 400, message: 'Invalid input', hint: 'Correct the input and retry.' },
    });
    const envelope = envelopeFromThrown(() => {
      new InvalidError.Invalid({ details: { limits: JSON.stringify({ max: 3 }) } });
    });
    expect(validateErrorEnvelope(envelope)).toEqual([]);
    expect(envelope.code).toBe('KB_PLUGIN_CONTRACT_VIOLATION');
    expect(envelope.hint).toContain('error.diagnostics');
  });

  it('uses catalog status and details when a PluginError carries a catalog code', () => {
    const envelope = toErrorEnvelope(new PluginError('x', 'KB_PLUGIN_NOT_FOUND', { plugin: 'acme' }));
    expect(envelope.area).toBe('plugin');
    expect(envelope.message).toBe('x');
    expect(envelope.details).toEqual({ plugin: 'acme' });
  });

  it('maps ServiceNotConfiguredError to KB_ADAPTER_NOT_CONFIGURED', () => {
    const envelope = toErrorEnvelope(new ServiceNotConfiguredError('llm', '@kb-labs/adapters-openai'));
    expect(validateErrorEnvelope(envelope)).toEqual([]);
    expect(envelope.code).toBe('KB_ADAPTER_NOT_CONFIGURED');
    expect(envelope.hint).toBe(
      'Run `kb adapter bind llm @kb-labs/adapters-openai` to bind an installed adapter for this capability.',
    );

    const cacheAdapter = toErrorEnvelope(new ServiceNotConfiguredError('cache', '@kb-labs/adapters-redis'));
    expect(cacheAdapter.hint).toBe(
      'Run `kb adapter bind cache @kb-labs/adapters-redis` to bind an installed adapter for this capability.',
    );
  });

  // case: S-203.2
  it('maps ValidationError issues into details', () => {
    const envelope = toErrorEnvelope(
      new ValidationError('bad input', [
        { path: 'name', message: 'Required' },
        { path: '', message: 'Unexpected value' },
      ]),
    );
    expect(validateErrorEnvelope(envelope)).toEqual([]);
    expect(envelope.code).toBe('KB_RUNTIME_INPUT_INVALID');
    expect(envelope.details).toEqual({ field: 'name, value' });
  });

  it('delegates AdapterUnavailableError and unknown values to core-platform', () => {
    expect(toErrorEnvelope(new AdapterUnavailableError('llm')).code).toBe('KB_ADAPTER_NOT_CONFIGURED');
    expect(toErrorEnvelope(new Error('boom')).code).toBe('KB_RUNTIME_UNEXPECTED');
  });
});

function envelopeFromThrown(run: () => void) {
  try {
    run();
  } catch (error) {
    return toErrorEnvelope(error);
  }
  throw new Error('Expected product error construction to reject structured details.');
}
