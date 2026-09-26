import { describe, expect, it } from 'vitest';
import { validateErrorEnvelope } from '@kb-labs/core-platform';
import {
  AbortError,
  ConfigError,
  PermissionError,
  PlatformError,
  PluginError,
  RateLimitError,
  TimeoutError,
  ValidationError,
} from './errors.js';
import { toPluginErrorEnvelope } from './error-envelope.js';

describe('toPluginErrorEnvelope', () => {
  const cases: Array<[string, PluginError, string]> = [
    ['validation', new ValidationError('bad', { field: 'cwd' }), 'KB_RUNTIME_INPUT_INVALID'],
    ['config', new ConfigError('bad config', { path: 'llm.model' }), 'KB_CONFIG_INVALID'],
    ['timeout', new TimeoutError('slow'), 'KB_RUNTIME_TIMEOUT'],
    ['permission', new PermissionError('no', { plugin: 'commit', permission: 'fs.write' }), 'KB_PLUGIN_PERMISSION_DENIED'],
    ['rate limit', new RateLimitError('slow down', 2500), 'KB_RUNTIME_RATE_LIMITED'],
    ['platform', new PlatformError('llm', 'down'), 'KB_HOST_ADAPTER_UNAVAILABLE'],
    ['abort', new AbortError(), 'PLUGIN_ABORTED'],
    ['custom', new PluginError('boom', 'COMMIT_PUSH_REJECTED'), 'COMMIT_PUSH_REJECTED'],
  ];

  for (const [name, error, code] of cases) {
    it(`maps ${name} to ${code} as a valid envelope`, () => {
      const envelope = toPluginErrorEnvelope(error, { correlationId: 'c1' });
      expect(validateErrorEnvelope(envelope)).toEqual([]);
      expect(envelope.code).toBe(code);
      expect(envelope.correlationId).toBe('c1');
    });
  }

  it('renders details into catalog templates', () => {
    expect(toPluginErrorEnvelope(new ConfigError('x', { path: 'llm.model' })).message).toContain('llm.model');
    expect(toPluginErrorEnvelope(new RateLimitError('x', 2500)).message).toContain('3s');
  });

  it('delegates non-plugin errors to core-platform', () => {
    expect(toPluginErrorEnvelope(new Error('boom')).code).toBe('KB_RUNTIME_UNEXPECTED');
  });
});
