/**
 * @module @kb-labs/plugin-runtime/__tests__/subprocess-integration
 *
 * Integration tests for subprocess execution with real IPC.
 *
 * These tests verify:
 * 1. Real subprocess spawn works
 * 2. Framed stdio communication between parent/child
 * 3. Metadata injection through subprocess boundary
 * 4. Timeout and abort handling
 *
 * NOTE: These require built bootstrap.js and are slower than unit tests.
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { createStdioChannel, StdioChannel } from '@kb-labs/core-ipc';
import { runInSubprocess } from '../sandbox/runner.js';
import { withProcessSensitiveValues } from '@kb-labs/core-platform';
import { wrapCliResult } from '../host/cli-wrapper.js';
import type { PluginContextDescriptor, CommandResult } from '@kb-labs/plugin-contracts';
import {
  AdapterUnavailableError,
  createProductErrorEnvelope,
  ErrorEnvelopeError,
  SerializedErrorEnvelopeError,
  toErrorEnvelope,
  validateErrorEnvelope,
} from '@kb-labs/core-platform';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import type { IPlatformAdapters } from '@kb-labs/core-platform';

function createPlatform(): IPlatformAdapters {
  const logger = {
    debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, trace: () => {}, fatal: () => {},
    child: () => logger,
  };
  return {
    logger,
    cache: { get: async (key: string) => `host:${key}`, set: async () => {}, delete: async () => {}, clear: async () => {} },
  } as unknown as IPlatformAdapters;
}

describe('Subprocess Integration Tests', () => {
  it('preserves canonical envelopes across real sandbox IPC', async () => {
    const testDir = join(tmpdir(), `sandbox-error-ipc-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    const descriptor: PluginContextDescriptor = {
      hostType: 'cli',
      pluginId: '@kb-labs/test-sandbox-error',
      pluginVersion: '1.0.0',
      requestId: 'sandbox-error-ipc',
      handlerId: 'test:sandbox-error',
      permissions: {},
      hostContext: { host: 'cli', binaryName: 'kb', argv: [], flags: {} },
    };
    const handlerPath = new URL('./fixtures/sandbox-error-handler.mjs', import.meta.url).pathname;

    try {
      const cases = [
        {
          kind: 'adapter',
          original: () => {
            const error = new AdapterUnavailableError(
              'llm', 'load-failed', 'fixture adapter failed to load', undefined, {
                hint: 'Inspect the fixture adapter and retry.',
                userMessage: 'The fixture adapter is unavailable.',
                action: {
                  id: 'inspect-fixture-adapter',
                  label: 'Inspect fixture adapter',
                  command: 'kb adapter bind llm @kb-labs/adapters-openai',
                },
              },
            );
            error.stack = 'AdapterUnavailableError: fixture adapter failed to load\n    at fixture (sandbox-error-handler.mjs:1:1)';
            return error;
          },
        },
        {
          kind: 'product',
          original: () => {
            const error = new ErrorEnvelopeError(createProductErrorEnvelope({
              code: 'SANDBOX_FIXTURE_FAILED',
              message: 'Fixture product failure.',
              hint: 'Repair the fixture product failure and retry.',
              retryable: false,
              details: { fixture: 'sandbox-error-handler' },
              actions: [{
                id: 'repair-fixture',
                label: 'Repair fixture',
                command: 'kb plugin repair sandbox-fixture',
              }],
            }));
            error.stack = 'ProductFailure: Fixture product failure.\n    at fixture (sandbox-error-handler.mjs:2:1)';
            return error;
          },
        },
      ];

      for (const testCase of cases) {
        const original = testCase.original();
        let failure: unknown;
        try {
          await runInSubprocess({
            descriptor,
            platform: createPlatform(),
            handlerPath,
            input: { kind: testCase.kind },
            timeoutMs: 5000,
            cwd: testDir,
          });
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(SerializedErrorEnvelopeError);
        const transported = failure as SerializedErrorEnvelopeError;
        expect(transported.envelope).toEqual(toErrorEnvelope(original));
        expect(validateErrorEnvelope(transported.envelope)).toEqual([]);
        expect(transported.envelope).not.toHaveProperty('stack');
        expect(transported.serializedError.stack).toBe(original.stack);
      }
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  }, 15000);

  it('should execute handler in real subprocess and inject metadata', async () => {
    // This test requires:
    // 1. Built bootstrap.js
    // 2. Mock UnixSocket server for platform RPC
    // 3. Test handler file

    const testDir = join(tmpdir(), `subprocess-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    try {
      // Create test handler
      const handlerPath = join(testDir, 'subprocess-handler.mjs');
      const handlerCode = `
        export default {
          async execute(ctx, input) {
            return {
                message: 'Hello from subprocess',
                pid: process.pid,
                hasContext: ctx !== undefined,
            };
          }
        };
      `;
      writeFileSync(handlerPath, handlerCode);

      const descriptor: PluginContextDescriptor = {
          hostType: 'cli',
          pluginId: '@kb-labs/test-subprocess',
          pluginVersion: '1.0.0',
          requestId: 'subprocess-req-123',
          handlerId: 'test:subprocess',
          permissions: {},
          hostContext: { host: 'cli', binaryName: 'kb', argv: [], flags: {} },
        };

      const runResult = await runInSubprocess<CommandResult<unknown>>({
          descriptor,
          platform: createPlatform(),
          handlerPath,
          input: {},
          timeoutMs: 5000,
          cwd: testDir,
        });

        // Wrap into CLI format for assertion
        const result = wrapCliResult(runResult, descriptor);

        // Verify result
        expect(result.exitCode).toBe(0);
        expect(result.result).toBeDefined();
        expect((result.result as any).message).toBe('Hello from subprocess');
        expect((result.result as any).hasContext).toBe(true);
        expect((result.result as any).pid).not.toBe(process.pid); // Different process!

        // Verify metadata auto-injection
        expect(result.meta).toBeDefined();
        expect(result.meta?.executedAt).toBeDefined();
        expect(typeof result.meta?.duration).toBe('number');
        expect(result.meta?.pluginId).toBe('@kb-labs/test-subprocess');
        expect(result.meta?.pluginVersion).toBe('1.0.0');
        expect(result.meta?.commandId).toBe('test:subprocess');
        expect(result.meta?.host).toBe('cli');
        expect(result.meta?.requestId).toBe('subprocess-req-123');

    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  }, 10000);

  // case: S-203.26
  it('redacts subprocess stderr secrets split across writes and frame boundaries', async () => {
    const testDir = join(tmpdir(), `subprocess-stderr-redaction-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    const secret = 'subprocess-secret-cross-lines';
    try {
      const handlerPath = join(testDir, 'stderr-handler.mjs');
      writeFileSync(handlerPath, `export default { async execute() { process.stderr.write('subprocess-secret'); process.stderr.write('-cross-lines\\r'); return { ok: true }; } };`);
      const descriptor: PluginContextDescriptor = {
        hostType: 'cli', pluginId: '@kb-labs/test-subprocess', pluginVersion: '1.0.0',
        requestId: 'subprocess-stderr-redaction', handlerId: 'test:stderr', permissions: {},
        hostContext: { host: 'cli', binaryName: 'kb', argv: [], flags: {} },
      };
      const logs: string[] = [];
      const result = await withProcessSensitiveValues([secret], () => runInSubprocess({
        descriptor,
        platform: createPlatform(),
        handlerPath,
        input: {},
        timeoutMs: 5000,
        cwd: testDir,
        onLog: (entry) => logs.push(entry.message),
      }));
      expect(result.data).toEqual({ ok: true });
      expect(logs.join('')).not.toContain(secret);
      expect(logs.join('')).toContain('[REDACTED]');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  }, 10_000);

  it('loads the manifest-selected object export in subprocess mode', async () => {
    const testDir = join(tmpdir(), `sandbox-named-export-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    try {
      const modulePath = join(testDir, 'show-plan.mjs');
      writeFileSync(modulePath, `export const showPlan = { async execute(ctx) { return { cwd: ctx.cwd, selected: 'showPlan' }; } };`);
      const descriptor: PluginContextDescriptor = {
        hostType: 'cli', pluginId: '@kb-labs/commit', pluginVersion: '1.0.0',
        requestId: 'named-subprocess-export', handlerId: 'commit:plan:show', permissions: {},
        hostContext: { host: 'cli', binaryName: 'kb', argv: [], flags: {} },
      };
      const result = await runInSubprocess({
        descriptor,
        platform: createPlatform(),
        handlerPath: `${modulePath}#showPlan`,
        input: {},
        timeoutMs: 5_000,
        cwd: testDir,
      });
      expect(result.data).toEqual({ cwd: testDir, selected: 'showPlan' });
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  }, 10_000);

  it('reports a missing manifest-selected export as KB_PLUGIN_LOAD_FAILED', async () => {
    const testDir = join(tmpdir(), `sandbox-missing-export-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    try {
      const modulePath = join(testDir, 'show-plan.mjs');
      writeFileSync(modulePath, `export const other = { async execute() { return { selected: 'other' }; } };`);
      const descriptor: PluginContextDescriptor = {
        hostType: 'cli', pluginId: '@kb-labs/commit', pluginVersion: '1.0.0',
        requestId: 'missing-subprocess-export', handlerId: 'commit:plan:show', permissions: {},
        hostContext: { host: 'cli', binaryName: 'kb', argv: [], flags: {} },
      };
      let failure: unknown;
      try {
        await runInSubprocess({
          descriptor,
          platform: createPlatform(),
          handlerPath: `${modulePath}#showPlan`,
          input: {},
          timeoutMs: 5_000,
          cwd: testDir,
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(SerializedErrorEnvelopeError);
      expect((failure as SerializedErrorEnvelopeError).envelope.code).toBe('KB_PLUGIN_LOAD_FAILED');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  }, 10_000);

  // case: S-030.3
  it('aborts a live host RPC and completes channel cleanup when execution times out', async () => {
    const testDir = join(tmpdir(), `subprocess-rpc-cleanup-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    const handlerPath = join(testDir, 'host-rpc-handler.mjs');
    writeFileSync(handlerPath, `export default { async execute(ctx) { await ctx.platform.llm.complete('long request'); } };`);
    const descriptor: PluginContextDescriptor = {
      hostType: 'cli', pluginId: '@kb-labs/test-rpc-cleanup', pluginVersion: '1.0.0',
      requestId: 'subprocess-rpc-cleanup', handlerId: 'test:rpc-cleanup', permissions: { platform: { llm: true } },
      hostContext: { host: 'cli', binaryName: 'kb', argv: [], flags: {} },
    };
    let providerSignal: AbortSignal | undefined;
    let resolveRpcStarted!: () => void;
    const rpcStarted = new Promise<void>((resolve) => { resolveRpcStarted = resolve; });
    const channelClose = vi.spyOn(StdioChannel.prototype, 'close');
    const platform = {
      ...createPlatform(),
      llm: {
        complete: (_prompt: string, options?: { signal?: AbortSignal }) => {
          providerSignal = options?.signal;
          resolveRpcStarted();
          return new Promise((_resolve, reject) => {
            providerSignal?.addEventListener('abort', () => reject(providerSignal?.reason ?? new DOMException('closed', 'AbortError')), { once: true });
          });
        },
      },
    } as unknown as IPlatformAdapters;

    try {
      const execution = runInSubprocess({
        descriptor, platform, handlerPath, input: {}, timeoutMs: 3000, cwd: testDir,
      }).then(
        () => ({ status: 'resolved' as const }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      );
      await Promise.race([
        rpcStarted,
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error('Subprocess never reached the host RPC')), 5_000);
        }),
      ]);
      const outcome = await execution;
      expect(outcome.status).toBe('rejected');
      if (outcome.status === 'rejected') {
        expect(outcome.error).toMatchObject({ message: expect.stringMatching(/timed out/) });
      }
      expect(providerSignal).toBeDefined();
      expect(providerSignal?.aborted).toBe(true);
      expect(channelClose).toHaveBeenCalled();
    } finally {
      channelClose.mockRestore();
      rmSync(testDir, { recursive: true, force: true });
    }
  }, 10_000);

  it('handles Ctrl+C after the subprocess control pipe has closed without an unhandled rejection', async () => {
    const testDir = join(tmpdir(), `subprocess-cancel-closed-stdio-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    const handlerPath = join(testDir, 'closed-stdio-handler.mjs');
    writeFileSync(handlerPath, `export default { async execute() { console.log('closed-stdio-ready'); await new Promise(() => {}); } };`);
    const descriptor: PluginContextDescriptor = {
      hostType: 'cli', pluginId: '@kb-labs/test-closed-stdio', pluginVersion: '1.0.0',
      requestId: 'subprocess-cancel-closed-stdio', handlerId: 'test:closed-stdio', permissions: {},
      hostContext: { host: 'cli', binaryName: 'kb', argv: [], flags: {} },
    };
    const controller = new AbortController();
    const unhandled: unknown[] = [];
    let channel: StdioChannel | undefined;
    const originalSend = StdioChannel.prototype.send;
    const sendSpy = vi.spyOn(StdioChannel.prototype, 'send').mockImplementation(function (this: StdioChannel, frame) {
      channel = this;
      return originalSend.call(this, frame);
    });
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on('unhandledRejection', onUnhandled);

    try {
      await expect(runInSubprocess({
        descriptor,
        platform: createPlatform(),
        handlerPath,
        input: {},
        signal: controller.signal,
        timeoutMs: 5000,
        cwd: testDir,
        onLog: (entry) => {
          if (entry.message.includes('closed-stdio-ready')) {
            channel?.close();
            setTimeout(() => controller.abort(), 50);
          }
        },
      })).rejects.toMatchObject({ name: 'AbortError' });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      sendSpy.mockRestore();
      process.off('unhandledRejection', onUnhandled);
      rmSync(testDir, { recursive: true, force: true });
    }
  }, 10_000);

  // case: S-203.26
  it('redacts messages across subprocess stdout IPC frames', async () => {
    const testDir = join(tmpdir(), `subprocess-ui-redaction-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    const handlerPath = join(testDir, 'ui-redaction-handler.mjs');
    writeFileSync(handlerPath, `export default { async execute() { process.stdout.write('prefix host-secret-'); process.stdout.write('split\\r'); return { ok: true }; } };`);
    const descriptor: PluginContextDescriptor = {
      hostType: 'cli', pluginId: '@kb-labs/test-ui-redaction', pluginVersion: '1.0.0',
      requestId: 'subprocess-ui-redaction', handlerId: 'test:ui-redaction', permissions: {},
      hostContext: { host: 'cli', binaryName: 'kb', argv: [], flags: {} },
    };
    const logs: string[] = [];

    try {
      const result = await withProcessSensitiveValues(['host-secret-split'], () => runInSubprocess({
        descriptor, platform: createPlatform(), handlerPath, input: {}, timeoutMs: 5000, cwd: testDir,
        onLog: (entry) => logs.push(entry.message),
      }));
      expect(result.data).toEqual({ ok: true });
      expect(logs.join('')).toContain('[REDACTED]');
      expect(logs.join('')).not.toContain('host-secret-split');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  }, 10_000);

  // case: S-244.9
  it('multiplexes platform RPC and console logs without corrupting framed stdout', async () => {
    const testDir = join(tmpdir(), `subprocess-stdio-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    try {
      const handlerPath = join(testDir, 'stdio-handler.mjs');
      writeFileSync(handlerPath, `export default { async execute(ctx) { console.log('stdio-log-marker'); return ctx.platform.cache.get('fixture-key'); } };`);
      const descriptor: PluginContextDescriptor = {
        hostType: 'cli', pluginId: '@kb-labs/test-stdio', pluginVersion: '1.0.0',
        requestId: 'stdio-req', handlerId: 'test:stdio', permissions: { platform: { cache: true } },
        hostContext: { host: 'cli', binaryName: 'kb', argv: [], flags: {} },
      };
      const logs: string[] = [];
      const result = await runInSubprocess({
        descriptor,
        platform: createPlatform(),
        handlerPath,
        input: {},
        timeoutMs: 5000,
        cwd: testDir,
        onLog: (entry) => logs.push(entry.message),
      });
      expect(result.data).toBe('host:fixture-key');
      expect(logs.join('')).toContain('stdio-log-marker');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  }, 10000);

  it('exits the bootstrap when the host closes stdin', async () => {
    const testDir = join(tmpdir(), `bootstrap-eof-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    const handlerPath = join(testDir, 'long-running-handler.mjs');
    writeFileSync(handlerPath, `export default { async execute() { console.log('bootstrap-running'); setInterval(() => {}, 1000); return new Promise(() => {}); } };`);
    const bootstrapPath = resolve(process.cwd(), 'dist/sandbox/bootstrap.js');
    const child = spawn(process.execPath, [bootstrapPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    const channel = createStdioChannel(child.stdout, child.stdin);
    const completion = once(child, 'exit');
    let removeReadyListener = () => {};
    let removeLogListener = () => {};
    const ready = new Promise<void>((resolveReady, rejectReady) => {
      removeReadyListener = channel.on('runtime:ready', () => resolveReady());
      channel.onError(rejectReady);
      child.once('error', rejectReady);
    });
    const running = new Promise<void>((resolveRunning, rejectRunning) => {
      removeLogListener = channel.on('log', (frame) => {
        if (frame.message.includes('bootstrap-running')) { resolveRunning(); }
      });
      channel.onError(rejectRunning);
    });

    try {
      let readinessTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          ready,
          new Promise<never>((_resolve, reject) => {
            readinessTimer = setTimeout(() => reject(new Error('Bootstrap did not send its readiness frame')), 5000);
          }),
        ]);
      } finally {
        clearTimeout(readinessTimer);
      }
      const descriptor: PluginContextDescriptor = {
        hostType: 'cli', pluginId: '@kb-labs/test-bootstrap-eof', pluginVersion: '1.0.0',
        requestId: 'bootstrap-eof-request', handlerId: 'test:bootstrap-eof', permissions: {},
        hostContext: { host: 'cli', binaryName: 'kb', argv: [], flags: {} },
      };
      await channel.send({
        type: 'execution:start',
        requestId: descriptor.requestId!,
        payload: {
          requestId: descriptor.requestId,
          descriptor,
          handlerPath,
          input: {},
          cwd: testDir,
          strictFilesystemPermissions: false,
        },
      });
      let runningTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          running,
          new Promise<never>((_resolve, reject) => {
            runningTimer = setTimeout(() => reject(new Error('Bootstrap did not start the long-running fixture')), 5000);
          }),
        ]);
      } finally {
        clearTimeout(runningTimer);
      }
      child.stdin.end();
      let exitTimer: ReturnType<typeof setTimeout> | undefined;
      let exit: Awaited<typeof completion>;
      try {
        exit = await Promise.race([
          completion,
          new Promise<never>((_resolve, reject) => {
            exitTimer = setTimeout(() => reject(new Error('Bootstrap remained alive after stdin EOF')), 2000);
          }),
        ]);
      } finally {
        clearTimeout(exitTimer);
      }
      const [code, signal] = exit;
      expect(code).not.toBeNull();
      expect(signal).toBeNull();
    } finally {
      removeReadyListener();
      removeLogListener();
      channel.close();
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await completion;
      }
      rmSync(testDir, { recursive: true, force: true });
    }
  }, 10000);

  it('should handle subprocess timeout', async () => {
    const testDir = join(tmpdir(), `subprocess-timeout-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    try {
      // Create handler that never completes
      const handlerPath = join(testDir, 'timeout-handler.mjs');
      const handlerCode = `
        export default {
          async execute(ctx, input) {
            // Infinite loop - will timeout
            await new Promise(() => {});
          }
        };
      `;
      writeFileSync(handlerPath, handlerCode);

      const descriptor: PluginContextDescriptor = {
          hostType: 'cli',
          pluginId: '@kb-labs/test-timeout',
          pluginVersion: '1.0.0',
          requestId: 'timeout-req',
          permissions: {},
          hostContext: { host: 'cli', binaryName: 'kb', argv: [], flags: {} },
        };

        await expect(
          runInSubprocess({
            descriptor,
            platform: createPlatform(),
            handlerPath,
            input: {},
            timeoutMs: 1000, // 1 second timeout
            cwd: testDir,
          })
        ).rejects.toThrow(/timed out/);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  }, 10000);

  it('should handle abort signal in subprocess', async () => {
    const testDir = join(tmpdir(), `subprocess-abort-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    try {
      // Create handler that takes some time
      const handlerPath = join(testDir, 'abort-handler.mjs');
      const handlerCode = `
        export default {
          async execute(ctx, input) {
            // Wait for 5 seconds (will be aborted)
            await new Promise(resolve => setTimeout(resolve, 5000));
            return { ok: true, result: { completed: true } };
          }
        };
      `;
      writeFileSync(handlerPath, handlerCode);

      const descriptor: PluginContextDescriptor = {
          hostType: 'cli',
          pluginId: '@kb-labs/test-abort',
          pluginVersion: '1.0.0',
          requestId: 'abort-req',
          permissions: {},
          hostContext: { host: 'cli', binaryName: 'kb', argv: [], flags: {} },
        };

        const abortController = new AbortController();

        // Abort after 500ms
        setTimeout(() => abortController.abort(), 500);

        await expect(
          runInSubprocess({
            descriptor,
            platform: createPlatform(),
            handlerPath,
            input: {},
            signal: abortController.signal,
            timeoutMs: 10000,
            cwd: testDir,
          })
        ).rejects.toThrow(/abort/);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  }, 10000);
});
