import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { validateManifest, type ManifestV3 } from '@kb-labs/plugin-contracts';
import { createErrorEnvelope, createProductErrorEnvelope } from '@kb-labs/core-platform';
import { SessionManager } from '@kb-labs/sdk/gateway';
import { createProjectRegistry } from '@kb-labs/core-project-registry';

const cliPath = path.resolve(process.cwd(), 'dist/bin.js');
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../');
const pluginId = '@x243/stdout-fixture';

interface CliFixture {
  root: string;
  home: string;
  platformRoot: string;
  projectRoot: string;
  gatewayUrl: string;
  env: NodeJS.ProcessEnv;
  server: Server;
  marketplaceStatus: number;
  gatewayEvents: unknown[];
  gatewayRequest?: Record<string, unknown>;
  releaseHold?: () => void;
}

describe('CLI result descriptor boundary', () => {
  let fixture: CliFixture | undefined;

  afterEach(async () => {
    fixture?.releaseHold?.();
    if (fixture?.server.listening) {
      await new Promise<void>((resolve, reject) => { fixture!.server.close((error) => error ? reject(error) : resolve()); });
    }
    if (fixture) {await rm(fixture.root, { recursive: true, force: true });}
    fixture = undefined;
  });

  // case: S-203.1
  it('keeps a system JSON result on stdout and routes its human renderer to stderr', async () => {
    fixture = await createCliFixture('local');
    const result = await runCli(fixture, ['marketplace', 'plugins', 'list', '--json']);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expectOneJsonEnvelope(result.stdout, { ok: true });
    expect(result.stderr).toContain('0 plugins (0 enabled, 0 disabled)');
  });

  // case: S-256.4
  it('keeps shell completion candidates on result stdout', async () => {
    fixture = await createCliFixture('local');
    const result = await runCli(fixture, ['__complete', 'marketplace', 'plugin']);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout.split(/\r?\n/)).toContain('marketplace plugins');
    expect(result.stderr).toBe('');
  });

  // case: S-203.1
  it('keeps local plugin, SDK, console, and inherited child output off machine stdout', async () => {
    fixture = await createCliFixture('local');
    const result = await runCli(fixture, ['stdout', 'fixture', 'run', '--json']);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expectOneJsonEnvelope(result.stdout, { ok: true, data: { complete: true, childStatus: 0 } });
    for (const text of [
      'fixture console progress',
      'fixture console error',
      'fixture direct progress',
      'fixture UI progress',
      'fixture child progress',
      'fixture result descriptor is closed',
    ]) {
      expect(result.stderr).toContain(text);
    }
    expect(result.stderr).not.toContain('fixture loader progress');
  });

  // case: S-284.8
  it('prints a catalogued error when the CLI command child is terminated before returning a result', async () => {
    fixture = await createCliFixture('local', 'in-process');
    const result = await runCli(fixture, ['stdout', 'fixture', 'terminate', '--json']);
    const cause = 'terminated by signal SIGKILL';
    const expectedError = createErrorEnvelope('KB_CLI_RESULT_UNAVAILABLE', {
      cause,
      details: { cause, binary: 'bin.js' },
      templateValues: { cause, binary: 'bin.js' },
    });

    expect(result.status, result.stderr || result.stdout).toBe(1);
    expect(result.stdout, `stderr=${result.stderr}`).not.toBe('');
    expectOneJsonEnvelope(result.stdout, { ok: false, error: expectedError });
    expect(result.stdout).toContain(expectedError.message);
    expect(result.stdout).toContain(expectedError.hint);
    expect(result.stderr).not.toContain('fixture completed build');

    const humanResult = await runCli(fixture, ['stdout', 'fixture', 'terminate']);
    expect(humanResult.status, humanResult.stderr || humanResult.stdout).toBe(1);
    expect(humanResult.stdout).toBe('');
    expect(humanResult.stderr).toContain(expectedError.message);
    expect(humanResult.stderr).toContain(expectedError.hint);
  });

  // case: S-203.1
  it('keeps human command rendering on stdout and progress on stderr', async () => {
    fixture = await createCliFixture('local');
    const result = await runCli(fixture, ['stdout', 'fixture', 'run']);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain('fixture human result');
    expect(result.stdout).not.toContain('fixture loader progress');
    expect(result.stdout).not.toContain('fixture direct progress');
    expect(result.stderr).toContain('fixture loader progress');
    expect(result.stderr).toContain('fixture direct progress');
  });

  // case: S-203.1
  it('renders the human spinner on a PTY before the handler continues', async () => {
    fixture = await createCliFixture('local');
    const output = await runCliWithPty(fixture, ['stdout', 'fixture', 'run'], async (text) => {
      if (text.includes('⠋ fixture progress')) {
        await fetch(`${fixture!.gatewayUrl}/release`);
      }
    });

    expect(output.status).toBe(0);
    expect(output.stdout).toContain('⠋ fixture progress');
    expect(output.stdout).toContain('fixture human result');
  });

  // case: S-203.1
  it('serializes Gateway stdout events as diagnostics and the remote result once', async () => {
    fixture = await createCliFixture('secured');
    await saveSession(fixture);
    fixture.gatewayEvents = [
      {
        type: 'execution:output', requestId: 'req-fixture', executionId: 'exec-fixture',
        stream: 'stdout', data: 'fixture Gateway stdout diagnostic\n', timestamp: Date.now(),
      },
      {
        type: 'execution:done', requestId: 'req-fixture', executionId: 'exec-fixture',
        exitCode: 0, durationMs: 1, metadata: { result: { complete: true, remote: true } },
      },
    ];

    const result = await runCli(fixture, ['stdout', 'fixture', 'run', '--json']);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expectOneJsonEnvelope(result.stdout, { ok: true, data: { complete: true, remote: true } });
    expect(result.stderr).toContain('fixture Gateway stdout diagnostic');
    expect(fixture.gatewayRequest).toMatchObject({ pluginId, handlerRef: './handler.js' });
  });

  // case: S-203.1
  it('serializes Gateway failures as one JSON failure envelope', async () => {
    fixture = await createCliFixture('secured');
    await saveSession(fixture);
    const gatewayFailure = createProductErrorEnvelope({
      code: 'X243_FIXTURE_FAILED', message: 'Fixture Gateway failure', hint: 'Retry the command.', retryable: false,
    });
    fixture.gatewayEvents = [
      {
        type: 'execution:error', requestId: 'req-fixture', executionId: 'exec-fixture',
        error: gatewayFailure,
      },
      {
        type: 'execution:done', requestId: 'req-fixture', executionId: 'exec-fixture',
        exitCode: 1, durationMs: 1,
      },
    ];

    const result = await runCli(fixture, ['stdout', 'fixture', 'run', '--json']);

    expect(result.status).not.toBe(0);
    expectOneJsonEnvelope(result.stdout, {
      ok: false,
      error: { code: 'X243_FIXTURE_FAILED', message: 'Fixture Gateway failure' },
    });
    expect(result.stderr).toContain('Fixture Gateway failure');
  });

  // case: S-203.1
  it('refuses handler ctx.ui.json and emits only the catalogued command failure', async () => {
    fixture = await createCliFixture('local');
    const result = await runCli(fixture, ['stdout', 'fixture', 'json', '--json']);

    expectOneJsonEnvelope(result.stdout, {
      ok: false,
      error: { code: 'KB_PLUGIN_CONTRACT_VIOLATION' },
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('handler JSON must not be emitted');
  });

  // case: S-203.1
  it('does not let the former environment marker bypass the descriptor boundary', async () => {
    fixture = await createCliFixture('local');
    const result = await runCli(fixture, ['stdout', 'fixture', 'run', '--json'], {
      KB_CLI_RESULT_FD_READY: '1',
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expectOneJsonEnvelope(result.stdout, { ok: true, data: { complete: true } });
    expect(result.stderr).toContain('fixture direct progress');
  });

  // case: S-203.1
  it('delivers a result larger than the pipe buffer whole through a slow non-blocking stdout pipe', async () => {
    fixture = await createCliFixture('local');
    const result = await runCliThroughSlowPipe(fixture, ['stdout', 'fixture', 'large', '--json']);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(LARGE_RESULT_BYTES);
    const parsed = JSON.parse(result.stdout) as { ok: boolean; data: { payload: string } };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.payload.length).toBe(LARGE_RESULT_BYTES);
    expect(result.stdout).toBe(`${JSON.stringify(parsed)}\n`);
    expect(result.stderr).toContain('fixture large console noise');
    expect(result.stderr).toContain('fixture large direct noise');
  });

  // case: S-203.1
  it('keeps a discovery error diagnostic on stderr so stdout stays one JSON document', async () => {
    fixture = await createCliFixture('local');
    const brokenRoot = path.join(fixture.projectRoot, 'plugins', 'broken-fixture');
    await mkdir(brokenRoot, { recursive: true });
    await writeFile(path.join(brokenRoot, 'package.json'), JSON.stringify({
      name: '@x281/broken-fixture', version: '1.0.0', type: 'module', kb: { manifest: 'manifest.json' },
    }));
    await writeFile(path.join(brokenRoot, 'manifest.json'), '{ "schema": "kb.plugin/3", "id": ');

    const result = await runCli(fixture, ['stdout', 'fixture', 'run', '--json']);

    expect(result.stderr).toMatch(/\[discover\] error /);
    expectOneJsonEnvelope(result.stdout, { ok: true, data: { complete: true } });
    expect(result.stdout).not.toContain('[discover]');
  });

  // case: S-203.1
  it('does not pass the CLI result descriptor to an isolated plugin handler', async () => {
    fixture = await createCliFixture('local', 'subprocess');
    const result = await runCli(fixture, ['stdout', 'fixture', 'descriptor', '--json'], {}, true);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expectOneJsonEnvelope(result.stdout, {
      ok: true,
      data: { resultDescriptorUnavailable: true },
    });
    expect(result.inheritedDescriptor).toBe('');
  });
});

async function createCliFixture(
  accessMode: 'local' | 'secured',
  executionMode?: 'in-process' | 'subprocess' | 'worker-pool',
): Promise<CliFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kb-cli-result-fd-'));
  const home = path.join(root, 'home');
  const platformRoot = path.join(root, 'platform');
  const projectRoot = path.join(root, 'project');
  await Promise.all([
    mkdir(path.join(home, '.kb'), { recursive: true }),
    mkdir(path.join(platformRoot, '.kb'), { recursive: true }),
    mkdir(path.join(platformRoot, 'node_modules'), { recursive: true }),
    mkdir(path.join(projectRoot, '.kb'), { recursive: true }),
  ]);

  const state: Omit<CliFixture, 'gatewayUrl' | 'env' | 'server'> = {
    root,
    home,
    platformRoot,
    projectRoot,
    marketplaceStatus: 200,
    gatewayEvents: [],
  };
  const server = createServer(async (request, response) => {
    if (request.url === '/auth/me') {
      sendJson(response, 200, { ok: true, data: { email: 'fixture@example.test', tenantId: 'fixture' } });
      return;
    }
    if (request.url === '/hold') {
      await new Promise<void>((resolve) => { state.releaseHold = resolve; });
      sendJson(response, 200, { ok: true, data: {} });
      return;
    }
    if (request.url === '/release') {
      state.releaseHold?.();
      state.releaseHold = undefined;
      sendJson(response, 200, { ok: true, data: {} });
      return;
    }
    if (request.url === '/api/v1/execute') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {chunks.push(Buffer.from(chunk));}
      state.gatewayRequest = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      for (const event of state.gatewayEvents) {response.write(`${JSON.stringify(event)}\n`);}
      response.end();
      return;
    }
    if (request.url?.startsWith('/api/v1/marketplace/packages')) {
      if (state.marketplaceStatus !== 200) {
        sendJson(response, state.marketplaceStatus, {
          ok: false,
          error: { code: 'KB_RUNTIME_UNEXPECTED', message: 'Fixture marketplace failure', hint: 'Retry the command.' },
        });
        return;
      }
      sendJson(response, 200, { entries: [], total: 0 });
      return;
    }
    sendJson(response, 404, { ok: false, error: { code: 'KB_RUNTIME_RESOURCE_NOT_FOUND', message: 'Fixture route missing' } });
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') {throw new Error('Fixture Gateway did not bind an ephemeral TCP port');}
  const gatewayUrl = `http://127.0.0.1:${address.port}`;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    KB_HOME: path.join(home, '.kb'),
    KB_PLATFORM_ROOT: platformRoot,
    KB_PROJECT_ROOT: projectRoot,
    KB_GATEWAY_URL: gatewayUrl,
    KB_MARKETPLACE_URL: gatewayUrl,
    KB_LOG_LEVEL: 'silent',
    CLI_VERSION: '2.120.1',
    NODE_ENV: 'production',
  };
  delete env.KB_NET_OFFSET;
  delete env.KB_OUTPUT_MODE;
  delete env.KB_PROJECT_ID;
  await writeFile(path.join(platformRoot, '.kb', 'kb.config.json'), JSON.stringify({
    gateway: { access: { mode: accessMode } },
    platform: {
      mode: 'development',
      ...(executionMode ? { execution: { mode: executionMode } } : {}),
      adapters: { logger: '@kb-labs/adapters-pino' },
    },
  }));
  await writeFile(path.join(platformRoot, 'pnpm-workspace.yaml'), 'packages:\n  - "adapters/*"\n');
  await symlink(path.join(workspaceRoot, 'adapters'), path.join(projectRoot, 'adapters'), 'dir');
  await symlink(path.join(workspaceRoot, 'adapters'), path.join(platformRoot, 'adapters'), 'dir');
  await symlink(path.join(workspaceRoot, 'tools'), path.join(platformRoot, 'tools'), 'dir');
  await mkdir(path.join(platformRoot, 'node_modules', '@kb-labs'), { recursive: true });
  await symlink(path.join(workspaceRoot, 'sdk', 'sdk'), path.join(platformRoot, 'node_modules', '@kb-labs', 'sdk'), 'dir');
  await writeFile(path.join(projectRoot, '.kb', 'kb.config.jsonc'), '{}\n');
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'x243-cli-fixture', private: true }));
  await writeFile(path.join(projectRoot, 'pnpm-workspace.yaml'), 'packages:\n  - "plugins/*"\n  - "adapters/*"\n');
  await createOutputFixturePlugin(projectRoot);
  await createProjectRegistry({ env }).add(projectRoot);

  return Object.assign(state, { gatewayUrl, env, server });
}

async function createOutputFixturePlugin(projectRoot: string): Promise<void> {
  const pluginRoot = path.join(projectRoot, 'plugins', 'stdout-fixture');
  await mkdir(path.join(pluginRoot, 'dist'), { recursive: true });
  await mkdir(path.join(pluginRoot, 'node_modules', '@kb-labs'), { recursive: true });
  const manifest = {
    schema: 'kb.plugin/3',
    id: pluginId,
    version: '1.0.0',
    display: { name: 'stdout fixture', description: 'CLI output boundary fixture' },
    platform: { requires: [], optional: [] },
    cli: { commands: [{
      path: 'stdout fixture run',
      describe: 'Exercise the CLI output descriptor boundary',
      handler: './handler.js#default',
      operationType: 'execute',
      flags: [{ name: 'json', type: 'boolean', description: 'Machine result output', default: false }],
    }, {
      path: 'stdout fixture json',
      describe: 'Attempt forbidden handler JSON output',
      handler: './json-handler.js',
      operationType: 'execute',
      flags: [{ name: 'json', type: 'boolean', description: 'Machine result output', default: false }],
    }, {
      path: 'stdout fixture descriptor',
      describe: 'Verify isolated handlers cannot write the CLI result descriptor',
      handler: './descriptor-handler.js',
      operationType: 'execute',
      flags: [{ name: 'json', type: 'boolean', description: 'Machine result output', default: false }],
    }, {
      path: 'stdout fixture large',
      describe: 'Return a result larger than any pipe buffer',
      handler: './large-handler.js',
      operationType: 'execute',
      flags: [{ name: 'json', type: 'boolean', description: 'Machine result output', default: false }],
    }, {
      path: 'stdout fixture terminate',
      describe: 'Terminate the CLI command child before it returns a result',
      handler: './terminate-handler.js',
      operationType: 'execute',
      flags: [{ name: 'json', type: 'boolean', description: 'Machine result output', default: false }],
    }] },
  } satisfies ManifestV3;
  const validation = validateManifest(manifest);
  if (!validation.valid) {throw new Error(`Invalid output fixture manifest: ${validation.errors.join('; ')}`);}

  await Promise.all([
    writeFile(path.join(pluginRoot, 'package.json'), JSON.stringify({
      name: pluginId,
      version: '1.0.0',
      type: 'module',
      kb: { manifest: 'manifest.json' },
    })),
    writeFile(path.join(pluginRoot, 'manifest.json'), JSON.stringify(manifest)),
    writeFile(path.join(pluginRoot, 'dist', 'handler.js'), fixtureHandlerSource),
    writeFile(path.join(pluginRoot, 'dist', 'json-handler.js'), jsonFixtureHandlerSource),
    writeFile(path.join(pluginRoot, 'dist', 'descriptor-handler.js'), descriptorFixtureHandlerSource),
    writeFile(path.join(pluginRoot, 'dist', 'large-handler.js'), largeFixtureHandlerSource),
    writeFile(path.join(pluginRoot, 'dist', 'terminate-handler.js'), terminateFixtureHandlerSource),
    symlink(path.join(workspaceRoot, 'sdk', 'sdk'), path.join(pluginRoot, 'node_modules', '@kb-labs', 'sdk'), 'dir'),
  ]);
}

const fixtureHandlerSource = `
import { spawnSync } from 'node:child_process';
import { useLoader } from '@kb-labs/sdk';

export default {
  async execute(ctx) {
    const loader = useLoader('fixture progress', { spinner: true, total: 1, current: 0 });
    loader.start();
    if (!process.env.KB_OUTPUT_MODE && process.stdout.isTTY) {
      await fetch(process.env.KB_GATEWAY_URL + '/hold');
    }
    loader.update({ current: 1 });
    loader.succeed('fixture loader progress');
    console.log('fixture console progress');
    console.error('fixture console error');
    process.stdout.write('fixture direct progress\\n');
    ctx.ui.write('fixture UI progress');
    const child = spawnSync(process.execPath, ['-e', \"process.stdout.write('fixture child progress\\\\n'); try { require('node:fs').writeSync(3, 'fixture result leak'); } catch { process.stderr.write('fixture result descriptor is closed\\\\n'); }\"], { stdio: 'inherit' });
    if (child.status !== 0) throw new Error('Fixture child failed');
    ctx.ui.success('fixture human result');
    return { complete: true, childStatus: child.status };
  },
};
`;

const jsonFixtureHandlerSource = `
export default {
  async execute(ctx) {
    ctx.ui.json({ message: 'handler JSON must not be emitted' });
    return { handlerReturned: true };
  },
};
`;

const descriptorFixtureHandlerSource = `
import { writeSync } from 'node:fs';

export default {
  async execute() {
    let resultDescriptorUnavailable = false;
    try {
      writeSync(3, 'plugin wrote to descriptor 3\\n');
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      resultDescriptorUnavailable = true;
    }
    return { resultDescriptorUnavailable };
  },
};
`;

const LARGE_RESULT_BYTES = 2 * 1024 * 1024;

const largeFixtureHandlerSource = `
export default {
  async execute() {
    console.log('fixture large console noise');
    process.stdout.write('fixture large direct noise\\n');
    return { payload: 'x'.repeat(${LARGE_RESULT_BYTES}) };
  },
};
`;

const terminateFixtureHandlerSource = `
import { useLoader } from '@kb-labs/sdk';

export default {
  async execute() {
    const loader = useLoader('fixture build');
    loader.fail('fixture completed build');
    process.kill(process.pid, 'SIGKILL');
  },
};
`;

async function saveSession(fixture: CliFixture): Promise<void> {
  const sessions = new SessionManager(path.join(fixture.home, '.kb', 'session.json'));
  await sessions.save({
    gatewayUrl: fixture.gatewayUrl,
    accessToken: 'fixture-access-token',
    refreshToken: 'fixture-refresh-token',
    expiresAt: Date.now() + 60 * 60 * 1000,
    email: 'fixture@example.test',
    tenantId: 'fixture',
  });
}

function runCli(
  fixture: CliFixture,
  args: string[],
  envOverrides: NodeJS.ProcessEnv = {},
  captureInheritedDescriptor = false,
): Promise<{ status: number | null; stdout: string; stderr: string; inheritedDescriptor: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, '--gateway-url', fixture.gatewayUrl, ...args], {
      cwd: fixture.projectRoot,
      env: { ...fixture.env, ...envOverrides },
      stdio: captureInheritedDescriptor ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let inheritedDescriptor = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, 30_000);
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.stdio[3]?.on('data', (chunk: Buffer | string) => { inheritedDescriptor += chunk; });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (status) => {
      clearTimeout(timer);
      resolve({ status: timedOut ? null : status, stdout, stderr, inheritedDescriptor });
    });
  });
}

const ptyScript = String.raw`
import errno, os, pty, select, subprocess, sys
master, slave = pty.openpty()
process = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave, close_fds=True)
os.close(slave)
os.set_blocking(master, False)
try:
    while process.poll() is None:
        ready, _, _ = select.select([master], [], [], 0.1)
        if not ready:
            continue
        try:
            chunk = os.read(master, 65536)
        except OSError as error:
            if error.errno == errno.EIO:
                break
            raise
        if not chunk:
            break
        sys.stdout.buffer.write(chunk)
        sys.stdout.buffer.flush()
    process.wait()
finally:
    os.close(master)
`;

function runCliWithPty(
  fixture: CliFixture,
  args: string[],
  onOutput: (text: string) => Promise<void>,
): Promise<{ status: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-c', ptyScript, process.execPath, cliPath, '--gateway-url', fixture.gatewayUrl, ...args], {
      cwd: fixture.projectRoot,
      env: fixture.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* process already exited */ }
    }, 30_000);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
      void onOutput(stdout).catch(reject);
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (status) => {
      clearTimeout(timer);
      resolve({ status: timedOut ? null : status, stdout });
    });
  });
}

/**
 * Runs the launcher behind a holder process whose stdout is a pipe it has initialised through
 * `process.stdout`, which makes the shared descriptor non-blocking exactly as a Node parent does.
 * The launcher inherits that descriptor, and this side drains it slowly, so a result larger than
 * the pipe buffer meets EAGAIN on the launcher's stdout.
 */
function runCliThroughSlowPipe(
  fixture: CliFixture,
  args: string[],
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const holder = `
    const { spawn } = require('node:child_process');
    process.stdout;
    const child = spawn(process.execPath, process.argv.slice(1), { stdio: ['ignore', 'inherit', 'inherit'] });
    child.once('close', (status) => process.exit(status ?? 1));
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', holder, cliPath, '--gateway-url', fixture.gatewayUrl, ...args], {
      cwd: fixture.projectRoot,
      env: fixture.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, 60_000);
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.stdout!.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      child.stdout!.pause();
      setTimeout(() => child.stdout!.resume(), 2);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (status) => {
      clearTimeout(timer);
      resolve({ status: timedOut ? null : status, stdout: Buffer.concat(chunks).toString('utf8'), stderr });
    });
  });
}

function expectOneJsonEnvelope(stdout: string, expected: Record<string, unknown>): void {
  const parsed: unknown = JSON.parse(stdout);
  expect(parsed).toMatchObject(expected);
  expect(stdout).toBe(`${JSON.stringify(parsed)}\n`);
}

function sendJson(response: import('node:http').ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(data));
}
