import { describe, expect, it } from 'vitest';
import { AdapterUnavailableError, validateErrorEnvelope } from '@kb-labs/core-platform';
import { PluginError, defineError, toErrorEnvelope } from '../errors/index';
import { ServiceNotConfiguredError } from '../helpers/platform';
import { ValidationError } from '../helpers/validation';

describe('toErrorEnvelope (command-kit adapter)', () => {
  it('maps a defineError PluginError to a product envelope', () => {
    const MindError = defineError('MIND', {
      IndexNotFound: { code: 404, message: (scope: string) => `Index '${scope}' not found` },
      Timeout: { code: 504, message: 'Query timed out' },
    });

    const notFound = toErrorEnvelope(new MindError.IndexNotFound('default'), { correlationId: 'c1' });
    expect(validateErrorEnvelope(notFound)).toEqual([]);
    expect(notFound).toMatchObject({
      code: 'MIND_INDEXNOTFOUND',
      area: 'product',
      severity: 'error',
      retryable: false,
      message: "Index 'default' not found",
      correlationId: 'c1',
      details: { statusCode: '404' },
    });

    const timeout = toErrorEnvelope(new MindError.Timeout());
    expect(timeout.retryable).toBe(true);
  });

  it('stringifies PluginError details and normalizes odd codes', () => {
    const envelope = toErrorEnvelope(
      new PluginError('weird code!', 'Nope', 400, { field: 'cwd', limits: { max: 3 } }),
    );
    expect(validateErrorEnvelope(envelope)).toEqual([]);
    expect(envelope.code).toBe('WEIRD_CODE');
    expect(envelope.details).toEqual({ field: 'cwd', limits: '{"max":3}', statusCode: '400' });
  });

  it('uses the catalog when a PluginError carries a catalog code', () => {
    const envelope = toErrorEnvelope(new PluginError('KB_PLUGIN_NOT_FOUND', 'x', 404, { plugin: 'acme' }));
    expect(envelope.area).toBe('plugin');
    expect(envelope.message).toBe('Plugin acme was not found in the registry.');
    expect(envelope.cause).toBe('x');
  });

  it('maps ServiceNotConfiguredError to KB_ADAPTER_NOT_CONFIGURED', () => {
    const envelope = toErrorEnvelope(new ServiceNotConfiguredError('llm', '@kb-labs/shared-openai'));
    expect(validateErrorEnvelope(envelope)).toEqual([]);
    expect(envelope.code).toBe('KB_ADAPTER_NOT_CONFIGURED');
    expect(envelope.hint).toContain('@kb-labs/shared-openai');

    const noAdapter = toErrorEnvelope(new ServiceNotConfiguredError('cache'));
    expect(noAdapter.hint).toContain('adapters.cache');
  });

  it('maps ValidationError issues into details', () => {
    const envelope = toErrorEnvelope(
      new ValidationError('bad input', [
        { path: 'name', message: 'Required' },
        { path: '', message: 'Unexpected value' },
      ]),
    );
    expect(validateErrorEnvelope(envelope)).toEqual([]);
    expect(envelope.code).toBe('KB_RUNTIME_INPUT_INVALID');
    expect(envelope.details).toEqual({ name: 'Required', value: 'Unexpected value' });
  });

  it('delegates AdapterUnavailableError and unknown values to core-platform', () => {
    expect(toErrorEnvelope(new AdapterUnavailableError('llm')).code).toBe('KB_ADAPTER_NOT_CONFIGURED');
    expect(toErrorEnvelope(new Error('boom')).code).toBe('KB_RUNTIME_UNEXPECTED');
  });
});
