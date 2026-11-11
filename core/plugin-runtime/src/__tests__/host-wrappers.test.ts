/**
 * @module @kb-labs/plugin-runtime/__tests__/host-wrappers
 *
 * Tests for host wrapper functions (wrapCliResult, wrapRestResult).
 * These wrappers transform RunResult<T> from runner layer into host-specific formats.
 */

import { describe, it, expect } from 'vitest';
import { wrapCliResult, wrapRestResult, unwrapRestData } from '../host/index.js';
import type { RunResult, ExecutionMeta, PluginContextDescriptor } from '@kb-labs/plugin-contracts';
import { createUxSuccessResult, isUxResult } from '@kb-labs/core-platform/ux-result';
import { createErrorEnvelope, createProductErrorEnvelope } from '@kb-labs/core-platform/error-envelope';

describe('Host Wrappers', () => {
  const mockExecutionMeta: ExecutionMeta = {
    startTime: Date.now() - 100,
    endTime: Date.now(),
    duration: 100,
    pluginId: '@kb-labs/test-plugin',
    pluginVersion: '1.0.0',
    handlerId: 'test:command',
    requestId: 'req-123',
    tenantId: 'tenant-456',
  };

  const mockDescriptor: PluginContextDescriptor = {
    hostType: 'cli',
    pluginId: '@kb-labs/test-plugin',
    pluginVersion: '1.0.0',
    requestId: 'req-123',
    handlerId: 'test:command',
    permissions: {},
    hostContext: { host: 'cli', binaryName: 'kb', argv: [], flags: {} },
    tenantId: 'tenant-456',
  };

  describe('wrapCliResult', () => {
    it('keeps an ok field in plain handler data', () => {
      const runResult: RunResult<{ ok: true; result: { data: string }; meta?: Record<string, unknown> }> = {
        ok: true,
        data: {
          ok: true,
          result: { data: 'success' },
          meta: { custom: 'value' },
        },
        executionMeta: mockExecutionMeta,
      };

      const result = wrapCliResult(runResult, mockDescriptor);

      expect(result.exitCode).toBe(0);
      expect(result.result).toEqual({ ok: true, result: { data: 'success' }, meta: { custom: 'value' } });
      expect(result.meta).toBeDefined();
      expect(result.meta?.pluginId).toBe('@kb-labs/test-plugin');
      expect(result.meta?.pluginVersion).toBe('1.0.0');
      expect(result.meta?.commandId).toBe('test:command');
      expect(result.meta?.host).toBe('cli');
      expect(result.meta?.requestId).toBe('req-123');
      expect(result.meta?.tenantId).toBe('tenant-456');
      expect(typeof result.meta?.duration).toBe('number');
      expect(result.meta?.executedAt).toBeDefined();
    });

    // case: S-203.1
    it('preserves a nested domain failure value inside success data', () => {
      const runResult: RunResult<unknown> = {
        ok: true,
        data: { status: 'degraded', report: { ok: false, issues: ['policy'] } },
        executionMeta: mockExecutionMeta,
      };

      const result = wrapCliResult(runResult, mockDescriptor);

      expect(result.exitCode).toBe(0);
      expect(result.ok).toBe(true);
      expect(result.result).toEqual({ status: 'degraded', report: { ok: false, issues: ['policy'] } });
    });

    it('rejects a handler-built success envelope instead of unwrapping it', () => {
      const envelope = createUxSuccessResult({ report: 'healthy' });
      expect(isUxResult(envelope)).toBe(true);
      const runResult: RunResult<unknown> = {
        ok: true,
        data: envelope,
        executionMeta: mockExecutionMeta,
      };

      const result = wrapCliResult(runResult, mockDescriptor);

      expect(result.exitCode).toBe(1);
      expect(result.ok).toBe(false);
      expect(result.error).toMatchObject({
        code: 'KB_PLUGIN_CONTRACT_VIOLATION',
        message: expect.stringContaining('violated the command result contract'),
        hint: expect.stringContaining('Return'),
      });
    });

    it('uses the shared UX-result contract to distinguish domain data from an envelope', () => {
      const domainValue = { ok: true, data: 'domain data', report: { status: 'healthy' } };
      expect(isUxResult(domainValue)).toBe(false);

      const result = wrapCliResult({
        ok: true,
        data: domainValue,
        executionMeta: mockExecutionMeta,
      }, mockDescriptor);

      expect(result.exitCode).toBe(0);
      expect(result.ok).toBe(true);
      expect(result.result).toEqual(domainValue);
    });

    it('normalizes the shared typed CommandFailure', () => {
      const runResult: RunResult<{ ok: false; error: { code: string; message: string; hint: string } }> = {
        ok: true,
        data: {
          ok: false,
          error: { code: 'KB_RUNTIME_COMMAND_FAILED', message: 'failed', hint: 'Resolve the failure, then retry.' },
        },
        executionMeta: mockExecutionMeta,
      };

      const result = wrapCliResult(runResult, mockDescriptor);

      expect(result.exitCode).toBe(1);
      expect(result.ok).toBe(false);
      expect(result.error).toMatchObject({ code: 'KB_RUNTIME_COMMAND_FAILED', message: 'failed', hint: 'Resolve the failure, then retry.' });
    });

    it('fills the execution correlation ID on a returned command failure that omitted it', () => {
      const result = wrapCliResult({
        ok: true,
        data: {
          ok: false,
          error: { code: 'KB_HOST_UNREACHABLE', message: 'The host is unavailable.' },
        },
        executionMeta: mockExecutionMeta,
      }, mockDescriptor);

      expect(result.exitCode).toBe(1);
      expect(result.error?.correlationId).toBe(mockExecutionMeta.requestId);
    });

    it('fills an omitted catalogued failure hint from the platform error catalogue', () => {
      const result = wrapCliResult({
        ok: true,
        data: {
          ok: false,
          error: { code: 'KB_RUNTIME_COMMAND_FAILED', message: 'failed' },
        },
        executionMeta: mockExecutionMeta,
      }, mockDescriptor);

      expect(result.exitCode).toBe(1);
      expect(result.error).toMatchObject({
        code: 'KB_RUNTIME_COMMAND_FAILED',
        message: 'failed',
        hint: createErrorEnvelope('KB_RUNTIME_COMMAND_FAILED', {
          templateValues: { binary: 'kb' },
        }).hint,
      });
    });

    // case: S-203.1
    it('rejects a top-level failure claim without the typed error contract', () => {
      const runResult: RunResult<unknown> = {
        ok: true,
        data: { ok: false, status: 'unhealthy', issues: ['invalid policy'] },
        executionMeta: mockExecutionMeta,
      };

      const result = wrapCliResult(runResult, mockDescriptor);

      expect(result.exitCode).toBe(1);
      expect(result.ok).toBe(false);
      expect(result.error).toMatchObject({
        code: 'KB_PLUGIN_CONTRACT_VIOLATION',
        message: expect.stringContaining('violated the command result contract'),
      });
    });

    it('rejects an uncatalogued KB code as a plugin contract violation', () => {
      const runResult: RunResult<unknown> = {
        ok: true,
        data: {
          ok: false,
          error: {
            code: 'KB_TYPO',
            message: 'A plugin reported an unknown failure.',
            hint: 'Use a code from the platform catalog.',
          },
        },
        executionMeta: mockExecutionMeta,
      };

      const result = wrapCliResult(runResult, mockDescriptor);

      expect(result.exitCode).toBe(1);
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('KB_PLUGIN_CONTRACT_VIOLATION');
    });

    it('rejects a product code without a hint as a plugin contract violation', () => {
      const result = wrapCliResult({
        ok: true,
        data: {
          ok: false,
          error: { code: 'COMMIT_NOTHING_STAGED', message: 'Nothing is staged.' },
        },
        executionMeta: mockExecutionMeta,
      }, mockDescriptor);

      expect(result.exitCode).toBe(1);
      expect(result.error?.code).toBe('KB_PLUGIN_CONTRACT_VIOLATION');
    });

    it('preserves diagnostics for a catalogued command failure', () => {
      const diagnostics = [{
        code: 'PLUGIN_POLICY_TYPE_INVALID',
        message: 'plugins.block must be an array.',
        severity: 'error' as const,
        path: '.kb/kb.config.json',
        hint: 'Set plugins.block to an array.',
      }];
      const runResult: RunResult<unknown> = {
        ok: true,
        data: {
          ok: false,
          error: {
            code: 'KB_PLUGIN_SETTINGS_INVALID',
            message: 'Plugin configuration is invalid.',
            hint: 'Fix the plugin configuration and retry.',
            details: { path: '.kb/kb.config.json' },
            diagnostics,
          },
        },
        executionMeta: mockExecutionMeta,
      };

      const result = wrapCliResult(runResult, mockDescriptor);

      expect(result.exitCode).toBe(1);
      expect(result.error?.code).toBe('KB_PLUGIN_SETTINGS_INVALID');
      expect(result.error?.diagnostics).toEqual(diagnostics);
    });

    it('preserves a valid product code, message, and hint for a returned command failure', () => {
      const productError = createProductErrorEnvelope({
        code: 'COMMIT_NOTHING_STAGED',
        message: 'Nothing is staged.',
        hint: 'Stage the intended changes, then retry.',
        retryable: false,
      });
      const result = wrapCliResult({
        ok: true,
        data: { ok: false, error: {
          code: productError.code,
          message: productError.message,
          hint: productError.hint,
        } },
        executionMeta: mockExecutionMeta,
      }, mockDescriptor);

      expect(result).toMatchObject({
        exitCode: 1,
        ok: false,
        error: {
          code: 'COMMIT_NOTHING_STAGED',
          message: 'Nothing is staged.',
          hint: 'Stage the intended changes, then retry.',
        },
      });
      expect(JSON.parse(JSON.stringify(result))).toMatchObject({
        ok: false,
        error: { code: 'COMMIT_NOTHING_STAGED', message: 'Nothing is staged.', hint: 'Stage the intended changes, then retry.' },
      });
    });

    it('should wrap raw data as exitCode 0', () => {
      const runResult: RunResult<{ message: string }> = {
        ok: true,
        data: { message: 'hello' },
        executionMeta: mockExecutionMeta,
      };

      const result = wrapCliResult(runResult, mockDescriptor);

      expect(result.exitCode).toBe(0);
      expect(result.result).toEqual({ message: 'hello' });
      expect(result.meta?.pluginId).toBe('@kb-labs/test-plugin');
    });

    it('should wrap void/undefined as exitCode 0', () => {
      const runResult: RunResult<void> = {
        ok: true,
        data: undefined,
        executionMeta: mockExecutionMeta,
      };

      const result = wrapCliResult(runResult, mockDescriptor);

      expect(result.exitCode).toBe(0);
      expect(result.result).toBeUndefined();
      expect(result.meta?.pluginId).toBe('@kb-labs/test-plugin');
    });

    it('should wrap null as exitCode 0', () => {
      const runResult: RunResult<null> = {
        ok: true,
        data: null,
        executionMeta: mockExecutionMeta,
      };

      const result = wrapCliResult(runResult, mockDescriptor);

      expect(result.exitCode).toBe(0);
      expect(result.result).toBeUndefined();
    });

    it('keeps meta when it is part of plain command data', () => {
      const runResult: RunResult<{ ok: true; meta: { customField: string; anotherField: number } }> = {
        ok: true,
        data: {
          ok: true,
          meta: { customField: 'test', anotherField: 42 },
        },
        executionMeta: mockExecutionMeta,
      };

      const result = wrapCliResult(runResult, mockDescriptor);

      expect(result.result).toMatchObject({ meta: { customField: 'test', anotherField: 42 } });
      // Standard fields should also be present
      expect(result.meta?.pluginId).toBe('@kb-labs/test-plugin');
    });
  });

  describe('wrapRestResult', () => {
    it('should wrap data with metadata headers', () => {
      const runResult: RunResult<{ items: string[] }> = {
        ok: true,
        data: { items: ['a', 'b', 'c'] },
        executionMeta: mockExecutionMeta,
      };

      const result = wrapRestResult(runResult);

      expect(result.data).toEqual({ items: ['a', 'b', 'c'] });
      expect(result.headers).toBeDefined();
      expect(result.headers['X-Plugin-Id']).toBe('@kb-labs/test-plugin');
      expect(result.headers['X-Plugin-Version']).toBe('1.0.0');
      expect(result.headers['X-Request-Id']).toBe('req-123');
      expect(result.headers['X-Handler-Id']).toBe('test:command');
      expect(result.headers['X-Tenant-Id']).toBe('tenant-456');
      expect(result.headers['X-Duration-Ms']).toBe('100');
    });

    it('should handle missing optional fields', () => {
      const metaWithoutOptional: ExecutionMeta = {
        startTime: Date.now() - 50,
        endTime: Date.now(),
        duration: 50,
        pluginId: '@kb-labs/minimal',
        pluginVersion: '0.0.1',
        requestId: 'req-minimal',
      };

      const runResult: RunResult<string> = {
        ok: true,
        data: 'simple-string',
        executionMeta: metaWithoutOptional,
      };

      const result = wrapRestResult(runResult);

      expect(result.data).toBe('simple-string');
      expect(result.headers['X-Plugin-Id']).toBe('@kb-labs/minimal');
      expect(result.headers['X-Handler-Id']).toBeUndefined();
      expect(result.headers['X-Tenant-Id']).toBeUndefined();
    });
  });

  describe('unwrapRestData', () => {
    it('should extract raw data from RunResult', () => {
      const runResult: RunResult<{ complex: { nested: string[] } }> = {
        ok: true,
        data: { complex: { nested: ['x', 'y', 'z'] } },
        executionMeta: mockExecutionMeta,
      };

      const data = unwrapRestData(runResult);

      expect(data).toEqual({ complex: { nested: ['x', 'y', 'z'] } });
    });

    it('should handle primitive data types', () => {
      const numberResult: RunResult<number> = {
        ok: true,
        data: 42,
        executionMeta: mockExecutionMeta,
      };

      const stringResult: RunResult<string> = {
        ok: true,
        data: 'hello',
        executionMeta: mockExecutionMeta,
      };

      const boolResult: RunResult<boolean> = {
        ok: true,
        data: true,
        executionMeta: mockExecutionMeta,
      };

      expect(unwrapRestData(numberResult)).toBe(42);
      expect(unwrapRestData(stringResult)).toBe('hello');
      expect(unwrapRestData(boolResult)).toBe(true);
    });

    it('should handle null', () => {
      const nullResult: RunResult<null> = {
        ok: true,
        data: null,
        executionMeta: mockExecutionMeta,
      };

      expect(unwrapRestData(nullResult)).toBeNull();
      // Note: undefined data is not allowed by unwrapRestData
      // (it throws "missing data" error)
    });

    it('should handle arrays', () => {
      const arrayResult: RunResult<string[]> = {
        ok: true,
        data: ['a', 'b', 'c'],
        executionMeta: mockExecutionMeta,
      };

      expect(unwrapRestData(arrayResult)).toEqual(['a', 'b', 'c']);
    });
  });

  describe('Type preservation', () => {
    it('should preserve generic type through wrapCliResult', () => {
      interface MyData {
        id: number;
        name: string;
      }

      const runResult: RunResult<MyData> = {
        ok: true,
        data: { id: 1, name: 'Test' },
        executionMeta: mockExecutionMeta,
      };

      const result = wrapCliResult(runResult, mockDescriptor);

      // TypeScript should infer result.result as MyData | undefined
      expect(result.result?.id).toBe(1);
      expect(result.result?.name).toBe('Test');
    });

    it('should preserve generic type through wrapRestResult', () => {
      interface ApiResponse {
        users: Array<{ id: number; email: string }>;
        total: number;
      }

      const runResult: RunResult<ApiResponse> = {
        ok: true,
        data: {
          users: [{ id: 1, email: 'test@example.com' }],
          total: 1,
        },
        executionMeta: mockExecutionMeta,
      };

      const result = wrapRestResult(runResult);

      // TypeScript should infer result.data as ApiResponse
      expect(result.data.users).toHaveLength(1);
      expect(result.data.total).toBe(1);
    });
  });
});
