import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AdapterUnavailableError,
  createErrorEnvelope,
  serializeError,
  toErrorEnvelope,
  validateErrorEnvelope,
} from '@kb-labs/core-platform';
import type { ILogger } from '@kb-labs/core-platform';
import { PluginError } from '@kb-labs/plugin-contracts';
import * as pluginContracts from '@kb-labs/plugin-contracts';
import { registry, registerBuiltinCommands } from '@kb-labs/cli-commands';
import { resolveCliHandlerPath } from '@kb-labs/core-platform';
import type { RegisteredCommand } from '@kb-labs/cli-commands';
import { fileURLToPath } from 'node:url';

const { executeCommandV3 } = vi.hoisted(() => ({ executeCommandV3: vi.fn() }));
vi.mock('@kb-labs/cli-runtime/v3', () => ({ executeCommandV3 }));

import { executePlugin, renderUnavailableAdapterError } from './plugin-executor.js';

describe('plugin executor adapter errors', () => {
  afterEach(() => vi.restoreAllMocks());


  it('renders an unconfigured capability as one line and marks it handled', () => {
    const errorOutput = vi.spyOn(console, 'error').mockImplementation(() => {});

    const handled = renderUnavailableAdapterError(new AdapterUnavailableError('llm'));

    expect(handled).toBe(true);
    expect(errorOutput).toHaveBeenCalledOnce();
    expect(errorOutput.mock.calls[0]?.[0]).toBe(
      'Service llm is not configured. Configure it with: kb adapter bind llm @kb-labs/adapters-openai',
    );
    expect(errorOutput.mock.calls[0]?.[0]).not.toContain(' at ');
  });

  it('leaves other errors to the regular plugin execution error path', () => {
    expect(renderUnavailableAdapterError(new Error('other failure'))).toBe(false);
  });

  // case: S-010.7
  it('passes the configured gateway address to the plugin backend without changing process.env', async () => {
    const matcher = vi.spyOn(pluginContracts, 'matchesPermissionPattern');
    executeCommandV3.mockResolvedValue(0);
    const previousGatewayUrl = process.env.KB_GATEWAY_URL;
    process.env.KB_GATEWAY_URL = 'http://127.0.0.1:43323';
    const manifestCmd = {
      pkgRoot: '/platform/plugins/commit',
      manifest: {
        id: '@kb-labs/commit',
        segments: ['commit', 'status'],
        v3Manifest: {
        id: '@kb-labs/commit',
        version: '1.0.0',
        permissions: { env: { read: ['KB_GATEWAY_URL'] } },
        cli: { commands: [{ path: 'commit status', handler: 'dist/index.js#status' }] },
        },
      },
    } as unknown as RegisteredCommand;
    const context = {
      cwd: '/project',
      presenter: {},
      logger: undefined,
    } as Parameters<typeof executePlugin>[0]['context'];
    const platform = {
      getAdapter: () => ({ listenAddress: () => ({ host: '127.0.0.1', port: 43323 }) }),
    } as unknown as Parameters<typeof executePlugin>[0]['platform'];

    try {
      const exitCode = await executePlugin({
        context,
        env: process.env,
        commandId: 'commit:status',
        argv: [],
        flags: {},
        manifestCmd,
        platform,
      });

      expect(exitCode).toBe(0);
      expect(matcher).toHaveBeenCalledWith('KB_GATEWAY_URL', 'KB_GATEWAY_URL');
      expect(executeCommandV3).toHaveBeenCalledWith(expect.objectContaining({
        env: { KB_GATEWAY_URL: 'http://127.0.0.1:43323' },
      }));
    } finally {
      if (previousGatewayUrl === undefined) {delete process.env.KB_GATEWAY_URL;}
      else {process.env.KB_GATEWAY_URL = previousGatewayUrl;}
      executeCommandV3.mockReset();
    }
  });

  // case: S-203.15
  it('passes the gateway address supplied by the CLI bootstrap to the plugin backend', async () => {
    executeCommandV3.mockResolvedValue(0);
    const previousGatewayUrl = process.env.KB_GATEWAY_URL;
    process.env.KB_GATEWAY_URL = 'http://127.0.0.1:4200';
    const manifestCmd = {
      pkgRoot: '/platform/plugins/commit',
      manifest: {
        id: '@kb-labs/commit',
        segments: ['commit', 'status'],
        v3Manifest: {
        id: '@kb-labs/commit',
        version: '1.0.0',
        permissions: { env: { read: ['KB_GATEWAY_URL'] } },
        cli: { commands: [{ path: 'commit status', handler: 'dist/index.js#status' }] },
        },
      },
    } as unknown as RegisteredCommand;

    try {
      const exitCode = await executePlugin({
        context: { cwd: '/project', presenter: {} } as Parameters<typeof executePlugin>[0]['context'],
        env: process.env,
        commandId: 'commit:status',
        argv: [],
        flags: {},
        manifestCmd,
        platform: {
          getAdapter: () => ({ listenAddress: () => undefined }),
        } as unknown as Parameters<typeof executePlugin>[0]['platform'],
      });

      expect(exitCode).toBe(0);
      expect(executeCommandV3).toHaveBeenCalledWith(expect.objectContaining({
        env: { KB_GATEWAY_URL: 'http://127.0.0.1:4200' },
      }));
    } finally {
      if (previousGatewayUrl === undefined) {delete process.env.KB_GATEWAY_URL;}
      else {process.env.KB_GATEWAY_URL = previousGatewayUrl;}
      executeCommandV3.mockReset();
    }
  });

  it('routes every registered bundled V3 handler through the execution runtime entry point', async () => {
    executeCommandV3.mockResolvedValue(0);
    const workspaceRoot = fileURLToPath(new URL('../../../..', import.meta.url));
    await registerBuiltinCommands({
      cwd: workspaceRoot,
      platformRoot: workspaceRoot,
      projectRoot: workspaceRoot,
      resolvePlatformVersion: async () => 'test',
      logger: {
        trace() {},
        debug() {},
        info() {},
        warn() {},
        error() {},
        fatal() {},
        flush: async () => {},
        child: () => noopLogger,
      } satisfies ILogger,
    });

    const handlers = registry.listCommands().flatMap((registered) => {
      const manifest = registered.manifest.v3Manifest;
      const commandPath = registered.manifest.segments.join(' ');
      const handler = manifest?.cli?.commands?.find((command) => command.path === commandPath);
      return handler ? [{ registered, commandPath, handler }] : [];
    });
    expect(handlers.length).toBeGreaterThan(0);

    const platform = {
      getAdapter: () => undefined,
    } as unknown as Parameters<typeof executePlugin>[0]['platform'];
    const context = {
      cwd: workspaceRoot,
      presenter: {},
    } as Parameters<typeof executePlugin>[0]['context'];

    for (const { registered, commandPath, handler } of handlers) {
      const exitCode = await executePlugin({
        context,
        env: process.env,
        commandId: commandPath.replaceAll(' ', ':'),
        argv: [],
        flags: {},
        manifestCmd: registered,
        platform,
      });
      expect(exitCode, `${registered.packageName} ${commandPath}`).toBe(0);
      expect(executeCommandV3).toHaveBeenLastCalledWith(expect.objectContaining({
        pluginRoot: registered.pkgRoot,
        handlerPath: resolveCliHandlerPath(registered.pkgRoot!, handler.handler),
      }));
    }

    expect(executeCommandV3).toHaveBeenCalledTimes(handlers.length);
  });

  it('serializes each injected failure class for every registered bundled V3 handler', async () => {
    const actualRuntime = await vi.importActual<typeof import('@kb-labs/cli-runtime/v3')>('@kb-labs/cli-runtime/v3');
    executeCommandV3.mockImplementation((options) => actualRuntime.executeCommandV3(options));
    const output = vi.fn((value: unknown) => JSON.stringify(value));
    const workspaceRoot = fileURLToPath(new URL('../../../..', import.meta.url));
    await registerBuiltinCommands({
      cwd: workspaceRoot,
      platformRoot: workspaceRoot,
      projectRoot: workspaceRoot,
      resolvePlatformVersion: async () => 'test',
      logger: {
        trace() {},
        debug() {},
        info() {},
        warn() {},
        error() {},
        fatal() {},
        flush: async () => {},
        child: () => noopLogger,
      } satisfies ILogger,
    });

    const handlers = registry.listCommands().flatMap((registered) => {
      const manifest = registered.manifest.v3Manifest;
      const commandPath = registered.manifest.segments.join(' ');
      const handler = manifest?.cli?.commands?.find((command) => command.path === commandPath);
      return handler ? [{ registered, commandPath, handler }] : [];
    });
    expect(handlers.length).toBeGreaterThan(0);

    const cases = [
      {
        name: 'plain Error',
        code: 'KB_PLUGIN_COMMAND_FAILED',
        buildEnvelope: (correlationId: string) => createErrorEnvelope('KB_PLUGIN_COMMAND_FAILED', {
          correlationId,
          details: { command: 'test command', failureReason: 'injected test failure', plugin: 'test-plugin' },
        }),
        error: () => new Error('registry plain failure'),
      },
      {
        name: 'typed product error',
        code: 'KB_PLUGIN_PERMISSION_DENIED',
        buildEnvelope: (correlationId: string) => toErrorEnvelope(
          new PluginError('registry typed product failure', 'KB_PLUGIN_PERMISSION_DENIED', { plugin: 'test-plugin', permission: 'cli.test' }),
          { correlationId },
        ),
        error: () => new PluginError('registry typed product failure', 'KB_PLUGIN_PERMISSION_DENIED', { plugin: 'test-plugin', permission: 'cli.test' }),
      },
      {
        name: 'platform adapter error',
        code: 'KB_ADAPTER_NOT_CONFIGURED',
        buildEnvelope: (correlationId: string) => toErrorEnvelope(new AdapterUnavailableError('llm'), { correlationId }),
        error: () => new AdapterUnavailableError('llm'),
      },
    ] as const;

    for (const failureCase of cases) {
      for (const { registered, commandPath, handler } of handlers) {
        output.mockClear();
        const platform = {
          getAdapter: () => undefined,
          executionBackend: {
            async execute(request: { descriptor: { requestId: string }; context?: { commandPath?: string } }) {
              const error = failureCase.error();
              const correlationId = request.descriptor.requestId;
              const envelope = failureCase.buildEnvelope(correlationId);
              return {
                ok: false as const,
                error: { ...envelope, error: serializeError(error), envelope },
                executionTimeMs: 1,
              };
            },
          },
        } as unknown as Parameters<typeof executePlugin>[0]['platform'];

        const exitCode = await executePlugin({
          context: {
            cwd: workspaceRoot,
            presenter: {},
          } as Parameters<typeof executePlugin>[0]['context'],
          env: process.env,
          commandId: commandPath.replaceAll(' ', ':'),
          argv: [],
          flags: { json: true },
          manifestCmd: registered,
          platform,
          resultWriter: output,
        });

        expect(exitCode, `${failureCase.name}: ${registered.packageName} ${commandPath}`).toBe(1);
        expect(output).toHaveBeenCalledOnce();
        const serialized = JSON.parse(String(output.mock.results[0]?.value)) as { ok: false; error: Record<string, unknown> };
        expect(serialized.ok).toBe(false);
        expect(serialized.error.code).toBe(failureCase.code);
        expect(serialized.error.correlationId).toEqual(expect.any(String));
        expect(serialized.error).not.toHaveProperty('stack');
        expect(validateErrorEnvelope(serialized.error)).toEqual([]);
        expect(executeCommandV3).toHaveBeenLastCalledWith(expect.objectContaining({
          pluginRoot: registered.pkgRoot,
          handlerPath: resolveCliHandlerPath(registered.pkgRoot!, handler.handler),
        }));
      }
    }

    executeCommandV3.mockReset();
    output.mockRestore();
  });
});

const noopLogger: ILogger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  flush: async () => {},
  child: () => noopLogger,
};
