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
import { describe, it, expect } from 'vitest';
import { createStdioChannel } from '@kb-labs/core-ipc';
import { runInSubprocess } from '../sandbox/runner.js';
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
import { symlinkSync } from 'node:fs';

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
  // case: S-243.9
  it('resolves an external peer SDK from the host root before filtering plugin environment', async () => {
    const testDir = join(tmpdir(), `sandbox-platform-root-${Date.now()}`);
    const releaseRoot = join(testDir, 'platform', 'releases', 'current');
    const platformRoot = join(testDir, 'platform', 'current');
    const pluginRoot = join(testDir, 'store', 'entries', 'publisher@1.0.0', 'node_modules', 'publisher');
    mkdirSync(releaseRoot, { recursive: true });
    mkdirSync(join(releaseRoot, 'node_modules', '@kb-labs', 'sdk'), { recursive: true });
    mkdirSync(join(pluginRoot, 'node_modules', '@kb-labs', 'sdk'), { recursive: true });
    symlinkSync(releaseRoot, platformRoot, 'dir');
    writeFileSync(join(releaseRoot, 'package.json'), JSON.stringify({ name: 'platform' }));
    writeFileSync(join(releaseRoot, 'node_modules', '@kb-labs', 'sdk', 'package.json'), JSON.stringify({
      name: '@kb-labs/sdk', type: 'module', exports: { '.': './index.mjs', './gateway': './gateway.mjs' },
    }));
    writeFileSync(join(releaseRoot, 'node_modules', '@kb-labs', 'sdk', 'index.mjs'), `export const owner = 'host';`);
    writeFileSync(join(releaseRoot, 'node_modules', '@kb-labs', 'sdk', 'gateway.mjs'), `export const gatewayOwner = 'host-gateway';`);
    writeFileSync(join(pluginRoot, 'package.json'), JSON.stringify({
      name: 'publisher', type: 'module', peerDependencies: { '@kb-labs/sdk': 'workspace:*' },
    }));
    writeFileSync(join(pluginRoot, 'node_modules', '@kb-labs', 'sdk', 'package.json'), JSON.stringify({
      name: '@kb-labs/sdk', type: 'module', exports: { '.': './index.mjs', './gateway': './gateway.mjs' },
    }));
    writeFileSync(join(pluginRoot, 'node_modules', '@kb-labs', 'sdk', 'index.mjs'),
      `throw new Error('plugin SDK copy must not load'); export const owner = 'plugin';`);
    const handlerPath = join(pluginRoot, 'handler.mjs');
    writeFileSync(handlerPath, [
      `import { owner } from '@kb-labs/sdk';`,
      `import { gatewayOwner } from '@kb-labs/sdk/gateway';`,
      `export default { execute: async () => ({ owner, gatewayOwner, platformRootVisible: process.env.KB_PLATFORM_ROOT ?? null }) };`,
    ].join('\n'));

    try {
      const result = await runInSubprocess({
        descriptor: {
          hostType: 'cli', pluginId: '@kb-labs/test-publisher', pluginVersion: '1.0.0',
          requestId: 'peer-sdk-platform-root', handlerId: 'test:publisher',
          permissions: { env: { read: ['KB_GATEWAY_URL'] } },
          hostContext: { host: 'cli', binaryName: 'kb', argv: [], flags: {} },
        },
        platform: createPlatform(), handlerPath, input: {}, cwd: testDir,
        platformRoot,
        environment: { KB_GATEWAY_URL: 'http://127.0.0.1:4300' },
      });

      expect(result.data).toEqual({ owner: 'host', gatewayOwner: 'host-gateway', platformRootVisible: null });
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  }, 15000);

  // case: S-243.9
  it('ignores request environment roots and uses only trusted module-origin discovery', async () => {
    const testDir = join(tmpdir(), `sandbox-platform-root-absent-${Date.now()}`);
    const candidateRoot = join(testDir, 'candidate-platform');
    const pluginRoot = join(testDir, 'store', 'entries', 'publisher@1.0.0', 'node_modules', 'publisher');
    mkdirSync(join(candidateRoot, 'node_modules', '@kb-labs', 'sdk'), { recursive: true });
    mkdirSync(pluginRoot, { recursive: true });
    writeFileSync(join(candidateRoot, 'node_modules', '@kb-labs', 'sdk', 'package.json'), JSON.stringify({
      name: '@kb-labs/sdk', type: 'module', exports: './index.mjs',
    }));
    writeFileSync(join(candidateRoot, 'node_modules', '@kb-labs', 'sdk', 'index.mjs'), `export const owner = 'wrong-root';`);
    writeFileSync(join(pluginRoot, 'package.json'), JSON.stringify({
      name: 'publisher', type: 'module', peerDependencies: { '@kb-labs/sdk': 'workspace:*' },
    }));
    const handlerPath = join(pluginRoot, 'handler.mjs');
    writeFileSync(handlerPath, `export default { execute: async () => import.meta.resolve('@kb-labs/sdk') };`);

    try {
      let result: Awaited<ReturnType<typeof runInSubprocess>> | undefined;
      let failure: unknown;
      try {
        result = await runInSubprocess({
          descriptor: {
            hostType: 'cli', pluginId: '@kb-labs/test-publisher', pluginVersion: '1.0.0',
            requestId: 'peer-sdk-root-absent', handlerId: 'test:publisher',
            permissions: { env: { read: ['KB_PLATFORM_ROOT'] } },
            hostContext: { host: 'cli', binaryName: 'kb', argv: [], flags: {} },
          },
          platform: createPlatform(), handlerPath, input: {}, cwd: testDir,
          environment: { KB_PLATFORM_ROOT: candidateRoot },
        });
      } catch (error) {
        failure = error;
      }
      if (result) {
        expect(result.data).toMatch(/@kb-labs[\\/]sdk/);
        expect(result.data).not.toContain(candidateRoot);
      } else {
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toMatch(/Cannot find package ['"]?@kb-labs\/sdk/);
        expect((failure as Error).message).not.toContain(candidateRoot);
      }
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  }, 15000);

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
