import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createErrorEnvelope, resolveCliGatewayTarget } from '@kb-labs/core-platform';
import { createProjectRegistry } from '@kb-labs/core-project-registry';
import { ProjectRegistryError } from '@kb-labs/core-project-registry';
import type { LoadPlatformConfigResult } from '@kb-labs/core-runtime';
import { platform as runtimePlatform } from '@kb-labs/core-runtime';
import { registerBuiltinCommands, registerBuiltinSystemCommands, registry } from '@kb-labs/cli-commands';
import { createPlatformConfigFixture } from './fixtures/platform-config.js';

const mocks = vi.hoisted(() => ({
  loadPlatformConfiguration: vi.fn(),
  resolveProjectConfig: vi.fn(),
  initializePlatform: vi.fn(),
  hasUsablePlatformAuth: vi.fn(),
  resolveActiveGateway: vi.fn(),
  tryResolveGateway: vi.fn(),
  executeViaGateway: vi.fn(),
  logger: {
    trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(),
    child() { return this; },
  },
}));

vi.mock('../platform-init.js', () => ({
  loadPlatformConfiguration: mocks.loadPlatformConfiguration,
  resolveProjectConfig: mocks.resolveProjectConfig,
  initializePlatform: mocks.initializePlatform,
}));
vi.mock('@kb-labs/cli-runtime/gateway', async (importOriginal) => ({
  ...await importOriginal<typeof import('@kb-labs/cli-runtime/gateway')>(),
  CredentialsManager: class { async load() { return null; } },
  hasUsablePlatformAuth: mocks.hasUsablePlatformAuth,
  resolveActiveGateway: mocks.resolveActiveGateway,
}));
vi.mock('../gateway-executor.js', () => ({
  tryResolveGateway: mocks.tryResolveGateway,
  executeViaGateway: mocks.executeViaGateway,
}));

import { executeCli } from '../bootstrap.js';

describe('secured CLI auth ordering', () => {
  let isolatedHome: string | undefined;
  const originalHome = process.env.HOME;
  const originalKbHome = process.env.KB_HOME;
  const originalPlatformRoot = process.env.KB_PLATFORM_ROOT;
  const originalNetOffset = process.env.KB_NET_OFFSET;
  const originalGatewayPort = process.env.GATEWAY_PORT;
  const originalGatewayUrl = process.env.KB_GATEWAY_URL;
  const originalLogStream = process.env.KB_LOG_STREAM;
  const originalOutputMode = process.env.KB_OUTPUT_MODE;
  const originalCliVersion = process.env.CLI_VERSION;
  const originalDiagnostics = process.env.KB_DIAGNOSTICS;
  const originalLogLevel = process.env.KB_LOG_LEVEL;
  let fixtureCatalogs: LoadPlatformConfigResult['catalog'][] = [];

  async function configFixture(cwd: string, rawConfig: Record<string, unknown>, projectScope?: 'required' | 'platform') {
    const loaded = await createPlatformConfigFixture({
      cwd,
      home: isolatedHome!,
      rawConfig,
      ...(projectScope ? { projectScope } : {}),
    });
    fixtureCatalogs.push(loaded.catalog);
    return loaded;
  }

  afterEach(async () => {
    await Promise.all(fixtureCatalogs.map((catalog) => catalog.dispose()));
    fixtureCatalogs = [];
    if (isolatedHome) await rm(isolatedHome, { recursive: true, force: true });
    isolatedHome = undefined;
    process.env.HOME = originalHome;
    process.env.KB_HOME = originalKbHome;
    process.env.KB_PLATFORM_ROOT = originalPlatformRoot;
    process.env.KB_NET_OFFSET = originalNetOffset;
    process.env.GATEWAY_PORT = originalGatewayPort;
    process.env.KB_GATEWAY_URL = originalGatewayUrl;
    process.env.KB_LOG_STREAM = originalLogStream;
    process.env.KB_OUTPUT_MODE = originalOutputMode;
    process.env.CLI_VERSION = originalCliVersion;
    process.env.KB_DIAGNOSTICS = originalDiagnostics;
    process.env.KB_LOG_LEVEL = originalLogLevel;
    vi.clearAllMocks();
  });

  beforeEach(() => {
    process.env.CLI_VERSION = '2.120.1';
    mocks.resolveActiveGateway.mockImplementation(({ platformRoot, env }) => resolveCliGatewayTarget(platformRoot, {
      gatewayUrl: env.KB_GATEWAY_URL,
      gatewayPort: env.GATEWAY_PORT,
      gatewayHost: env.GATEWAY_HOST,
      netOffset: Number(env.KB_NET_OFFSET ?? 0),
    }));
  });

  // case: S-031.1, S-041.8
  it('lets auth status report an expired saved session without refreshing it first', async () => {
    isolatedHome = await mkdtemp(path.join(os.tmpdir(), 'kb-cli-expired-session-'));
    process.env.HOME = isolatedHome;
    process.env.KB_HOME = path.join(isolatedHome, '.kb');
    process.env.KB_GATEWAY_URL = 'http://gateway.test';
    process.env.GATEWAY_PORT = '4300';
    delete process.env.KB_PLATFORM_ROOT;
    await mkdir(path.join(isolatedHome, '.kb'), { recursive: true });
    const sessionPath = path.join(isolatedHome, '.kb', 'session.json');
    await writeFile(sessionPath, JSON.stringify({
      gatewayUrl: 'http://gateway.test', accessToken: 'expired-access', refreshToken: 'valid-refresh',
      expiresAt: 0, email: 'member@example.test',
    }));
    const rawConfig = { gateway: { access: { mode: 'secured' } } };
    mocks.loadPlatformConfiguration.mockResolvedValue(await configFixture(isolatedHome, rawConfig));
    mocks.initializePlatform.mockResolvedValue({
      platform: { logger: mocks.logger, getAdapter: () => undefined }, platformConfig: {},
      rawConfig: { gateway: { access: { mode: 'secured' } } }, effectiveConfig: {},
      platformRoot: isolatedHome, projectRoot: undefined,
    });
    mocks.hasUsablePlatformAuth.mockImplementation(async () => {
      await writeFile(sessionPath, JSON.stringify({
        gatewayUrl: 'http://gateway.test', accessToken: 'refreshed-access', refreshToken: 'next-refresh',
        expiresAt: Date.now() + 900_000, email: 'member@example.test',
      }));
      return { authenticated: true };
    });
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});

    const exitCode = await executeCli(['auth', 'status', '--json'], { cwd: isolatedHome });
    const records = stdout.mock.calls.map(([record]) => String(record));

    expect(exitCode).toBe(0);
    expect(records).toHaveLength(1);
    expect(JSON.parse(records[0]!).data.session).toMatchObject({
      authenticated: true, tokenExpired: true, email: 'member@example.test',
    });
    expect(mocks.hasUsablePlatformAuth).not.toHaveBeenCalled();
  });

  // case: S-041.7, S-041.17, S-203.15
  it('returns the auth envelope from an unregistered project directory before project resolution', async () => {
    isolatedHome = await mkdtemp(path.join(os.tmpdir(), 'kb-cli-secured-auth-'));
    process.env.HOME = isolatedHome;
    process.env.KB_HOME = path.join(isolatedHome, '.kb');
    delete process.env.KB_GATEWAY_URL;
    delete process.env.KB_PLATFORM_ROOT;
    process.env.GATEWAY_PORT = '4300';
    process.env.KB_NET_OFFSET = '200';
    process.env.KB_DIAGNOSTICS = 'agent';
    process.env.KB_LOG_LEVEL = 'warn';

    const rawConfig = {
      gateway: { access: { mode: 'secured' } },
      platform: { adapterOptions: { serviceTransport: { services: { gateway: { url: 'http://127.0.0.1:4000' } } } } },
    };
    mocks.loadPlatformConfiguration.mockResolvedValue(await configFixture(
      path.join(isolatedHome, 'unregistered-project'), rawConfig,
    ));
    mocks.hasUsablePlatformAuth.mockResolvedValue({ authenticated: false });
    const diagnostic = vi.spyOn(runtimePlatform.logger, 'warn');

    const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});

    const exitCode = await executeCli(['config', 'show', '--json'], {
      cwd: path.join(isolatedHome, 'unregistered-project'),
    });

    const records = stdout.mock.calls.map(([record]) => String(record));
    expect(exitCode).toBe(1);
    expect(records).toHaveLength(1);
    expect(JSON.parse(records[0]!)).toMatchObject({
      ok: false,
      error: {
        code: 'KB_AUTH_REQUIRED',
        message: 'Authentication is required.',
        hint: createErrorEnvelope('KB_AUTH_REQUIRED', {
          details: { gatewayUrl: 'http://127.0.0.1:4500' },
        }).hint,
      },
    });
    const contextRecord = diagnostic.mock.calls.find(([message]) => message === 'CLI resolved invocation context')?.[1];
    expect(diagnostic.mock.calls.filter(([message]) => message === 'CLI resolved invocation context')).toHaveLength(1);
    expect(contextRecord).toMatchObject({
      accessMode: 'secured',
      platformConfigSource: path.join(isolatedHome, '.kb', 'kb.config.json'),
      commandPath: 'config show',
    });
    expect(JSON.parse(records[0]!).error.correlationId).toBe(contextRecord?.correlationId);
    expect(mocks.loadPlatformConfiguration).toHaveBeenCalledExactlyOnceWith(
      path.join(isolatedHome, 'unregistered-project'),
      undefined,
      'platform',
    );
    expect(mocks.resolveProjectConfig).not.toHaveBeenCalled();
    expect(mocks.initializePlatform).not.toHaveBeenCalled();
    expect(mocks.tryResolveGateway).not.toHaveBeenCalled();
    expect(mocks.executeViaGateway).not.toHaveBeenCalled();
  });

  // case: S-041.17
  it('denies project registration when the access mode cannot be resolved', async () => {
    isolatedHome = await mkdtemp(path.join(os.tmpdir(), 'kb-cli-unknown-access-mode-'));
    process.env.HOME = isolatedHome;
    process.env.KB_HOME = path.join(isolatedHome, '.kb');
    delete process.env.KB_GATEWAY_URL;
    delete process.env.KB_PLATFORM_ROOT;
    process.env.GATEWAY_PORT = '4300';
    process.env.KB_NET_OFFSET = '200';
    const project = path.join(isolatedHome, 'anonymous-project');
    await mkdir(project, { recursive: true });
    const rawConfig = { gateway: { access: {} } };
    mocks.loadPlatformConfiguration.mockResolvedValue(await configFixture(isolatedHome, rawConfig));
    mocks.hasUsablePlatformAuth.mockResolvedValue({ authenticated: false });
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});

    const exitCode = await executeCli(['project', 'add', project, '--json'], { cwd: isolatedHome });

    expect(exitCode).toBe(1);
    expect(stdout.mock.calls).toHaveLength(1);
    expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: {
        code: 'KB_AUTH_REQUIRED',
        hint: createErrorEnvelope('KB_AUTH_REQUIRED', { details: { gatewayUrl: 'http://127.0.0.1:4500' } }).hint,
      },
    });
    expect(mocks.hasUsablePlatformAuth).not.toHaveBeenCalled();
    expect(mocks.resolveProjectConfig).not.toHaveBeenCalled();
    expect(mocks.initializePlatform).not.toHaveBeenCalled();
  });

  // case: S-041.17
  it('joins project-resolution failures to the same resolved context record', async () => {
    isolatedHome = await mkdtemp(path.join(os.tmpdir(), 'kb-cli-project-error-context-'));
    process.env.HOME = isolatedHome;
    process.env.KB_HOME = path.join(isolatedHome, '.kb');
    process.env.KB_DIAGNOSTICS = 'agent';
    process.env.KB_LOG_LEVEL = 'warn';
    delete process.env.KB_GATEWAY_URL;
    delete process.env.KB_PLATFORM_ROOT;
    process.env.GATEWAY_PORT = '4300';
    process.env.KB_NET_OFFSET = '200';

    const rawConfig = { gateway: { access: { mode: 'secured' } } };
    mocks.loadPlatformConfiguration.mockResolvedValue(await configFixture(
      path.join(isolatedHome, 'unregistered-project'), rawConfig,
    ));
    mocks.hasUsablePlatformAuth.mockResolvedValue({ authenticated: true });
    mocks.resolveProjectConfig.mockRejectedValue(new ProjectRegistryError(
      'KB_PROJECT_UNKNOWN', 'No registered project matches this directory.', { path: 'unregistered' },
    ));
    const diagnostic = vi.spyOn(runtimePlatform.logger, 'warn');
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});

    const exitCode = await executeCli(['config', 'show', '--json'], {
      cwd: path.join(isolatedHome, 'unregistered-project'),
    });

    const records = stdout.mock.calls.map(([record]) => String(record));
    expect(exitCode).toBe(1);
    expect(records).toHaveLength(1);
    const envelope = JSON.parse(records[0]!).error;
    expect(envelope.code).toBe('KB_PROJECT_UNKNOWN');
    const contextRecord = diagnostic.mock.calls.find(([message]) => message === 'CLI resolved invocation context')?.[1];
    expect(diagnostic.mock.calls.filter(([message]) => message === 'CLI resolved invocation context')).toHaveLength(1);
    expect(contextRecord).toMatchObject({
      accessMode: 'secured',
      platformConfigSource: path.join(isolatedHome, '.kb', 'kb.config.json'),
      commandPath: 'config show',
      projectResolution: { cwd: path.join(isolatedHome, 'unregistered-project') },
    });
    expect(envelope.correlationId).toBe(contextRecord?.correlationId);
  });

  it('joins configuration-resolution failures to a context record with unresolved provenance', async () => {
    isolatedHome = await mkdtemp(path.join(os.tmpdir(), 'kb-cli-config-error-context-'));
    process.env.HOME = isolatedHome;
    process.env.KB_DIAGNOSTICS = 'agent';
    process.env.KB_LOG_LEVEL = 'warn';
    mocks.loadPlatformConfiguration.mockRejectedValue(new Error('invalid configuration'));
    const diagnostic = vi.spyOn(runtimePlatform.logger, 'warn');
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});

    const exitCode = await executeCli(['config', 'show', '--json'], { cwd: isolatedHome });

    const records = stdout.mock.calls.map(([record]) => String(record));
    expect(exitCode).toBe(1);
    expect(records).toHaveLength(1);
    const envelope = JSON.parse(records[0]!).error;
    const contextRecord = diagnostic.mock.calls.find(([message]) => message === 'CLI resolved invocation context')?.[1];
    expect(diagnostic.mock.calls.filter(([message]) => message === 'CLI resolved invocation context')).toHaveLength(1);
    expect(contextRecord).toMatchObject({
      accessMode: 'unknown',
      platformConfigSource: 'unresolved',
      commandPath: 'config show',
      projectResolution: { cwd: isolatedHome },
    });
    expect(envelope.correlationId).toBe(contextRecord?.correlationId);
  });

  // case: S-041.7, S-041.17, S-007.4
  it('gates every registered session-protected system command before project resolution in either project context', async () => {
    isolatedHome = await mkdtemp(path.join(os.tmpdir(), 'kb-cli-registry-auth-'));
    process.env.HOME = isolatedHome;
    process.env.KB_HOME = path.join(isolatedHome, '.kb');
    process.env.GATEWAY_PORT = '4300';
    process.env.KB_NET_OFFSET = '200';
    delete process.env.KB_GATEWAY_URL;
    delete process.env.KB_PLATFORM_ROOT;

    registerBuiltinSystemCommands();
    await registerBuiltinCommands({
      cwd: path.resolve(import.meta.dirname, '../../../../../'),
      platformRoot: path.resolve(import.meta.dirname, '../../../../../'),
      projectRoot: path.resolve(import.meta.dirname, '../../../../../'),
    });
    const commands = registry.listProtectionCommands()
      .filter(({ requiresSession }) => requiresSession)
      .map(({ path }) => path);
    expect(commands.length).toBeGreaterThan(0);
    mocks.hasUsablePlatformAuth.mockResolvedValue({ authenticated: false });
    const registeredProjectRoot = path.join(isolatedHome, 'registered-project');
    const unregisteredProjectRoot = path.join(isolatedHome, 'unregistered-project');
    await mkdir(registeredProjectRoot, { recursive: true });
    await mkdir(unregisteredProjectRoot, { recursive: true });
    const projectRegistry = createProjectRegistry({ root: path.join(isolatedHome, '.kb') });
    await projectRegistry.add(registeredProjectRoot);
    await projectRegistry.list();
    const rawConfig = { gateway: { access: { mode: 'secured' } } };
    mocks.loadPlatformConfiguration.mockImplementation(async (cwd: string) => configFixture(cwd, rawConfig));
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});

    for (const cwd of [registeredProjectRoot, unregisteredProjectRoot]) {
      for (const commandPath of commands) {
        const before = stdout.mock.calls.length;
        const exitCode = await executeCli([...commandPath, '--json'], { cwd });
        const records = stdout.mock.calls.slice(before).map(([record]) => String(record));

        expect(exitCode, commandPath.join(' ')).toBe(1);
        expect(records, commandPath.join(' ')).toHaveLength(1);
        expect(JSON.parse(records[0]!)).toMatchObject({ ok: false, error: {
          code: 'KB_AUTH_REQUIRED',
          message: 'Authentication is required.',
          hint: createErrorEnvelope('KB_AUTH_REQUIRED', {
            details: { gatewayUrl: 'http://127.0.0.1:4500' },
          }).hint,
        } });
      }
    }

    expect(mocks.resolveProjectConfig).not.toHaveBeenCalled();
    expect(mocks.initializePlatform).not.toHaveBeenCalled();
    expect(mocks.tryResolveGateway).not.toHaveBeenCalled();
    expect(mocks.executeViaGateway).not.toHaveBeenCalled();
  });

  // case: S-203.16
  it('returns the catalogued GATEWAY_PORT config error before the auth hint', async () => {
    isolatedHome = await mkdtemp(path.join(os.tmpdir(), 'kb-cli-invalid-gateway-port-'));
    process.env.HOME = isolatedHome;
    process.env.KB_HOME = path.join(isolatedHome, '.kb');
    process.env.GATEWAY_PORT = '4000oops';
    process.env.KB_DIAGNOSTICS = 'agent';
    process.env.KB_LOG_LEVEL = 'warn';
    delete process.env.KB_GATEWAY_URL;
    delete process.env.KB_PLATFORM_ROOT;
    delete process.env.KB_NET_OFFSET;

    const rawConfig = { gateway: { access: { mode: 'secured' } } };
    mocks.loadPlatformConfiguration.mockResolvedValue(await configFixture(isolatedHome, rawConfig));
    mocks.hasUsablePlatformAuth.mockResolvedValue({ authenticated: false });
    const diagnostic = vi.spyOn(runtimePlatform.logger, 'warn');
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});

    const exitCode = await executeCli(['config', 'show', '--json'], { cwd: isolatedHome });
    const records = stdout.mock.calls.map(([record]) => String(record));

    expect(exitCode).toBe(1);
    expect(records).toHaveLength(1);
    expect(JSON.parse(records[0]!)).toMatchObject({
      ok: false,
      error: { code: 'KB_CONFIG_INVALID', message: expect.stringContaining('GATEWAY_PORT') },
    });
    const envelope = JSON.parse(records[0]!).error;
    const contextRecord = diagnostic.mock.calls.find(([message]) => message === 'CLI resolved invocation context')?.[1];
    expect(contextRecord).toMatchObject({ accessMode: 'secured', commandPath: 'config show' });
    expect(envelope.correlationId).toBe(contextRecord?.correlationId);
    expect(mocks.hasUsablePlatformAuth).not.toHaveBeenCalled();
  });

  // case: S-203.2, S-047.3
  it('returns one JSON error envelope when a removed plugin command is unknown', async () => {
    isolatedHome = await mkdtemp(path.join(os.tmpdir(), 'kb-cli-secured-unknown-'));
    process.env.HOME = isolatedHome;
    process.env.KB_HOME = path.join(isolatedHome, '.kb');
    delete process.env.KB_PLATFORM_ROOT;
    delete process.env.KB_NET_OFFSET;
    delete process.env.GATEWAY_PORT;
    delete process.env.GATEWAY_HOST;
    delete process.env.KB_GATEWAY_URL;

    const rawConfig = { gateway: { access: { mode: 'local' } } };
    mocks.loadPlatformConfiguration.mockResolvedValue(await configFixture(isolatedHome, rawConfig));
    mocks.initializePlatform.mockResolvedValue({
      platform: { logger: mocks.logger, getAdapter: () => undefined }, platformConfig: {}, rawConfig, effectiveConfig: rawConfig,
      platformRoot: isolatedHome, projectRoot: undefined,
    });
    mocks.hasUsablePlatformAuth.mockResolvedValue(false);

    const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitCode = await executeCli(['commit', 'plan', 'show', '--json'], { cwd: isolatedHome });
    const records = stdout.mock.calls.map(([record]) => String(record));

    expect(exitCode).toBe(2);
    expect(JSON.parse(records[0]!)).toMatchObject({
      ok: false,
      error: { code: 'KB_RUNTIME_UNKNOWN_COMMAND', message: 'Unknown command: commit plan show' },
    });
    expect(mocks.hasUsablePlatformAuth).not.toHaveBeenCalled();
    expect(mocks.resolveProjectConfig).not.toHaveBeenCalled();
  });
});
