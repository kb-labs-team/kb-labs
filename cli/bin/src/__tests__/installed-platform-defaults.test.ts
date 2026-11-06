import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createErrorEnvelope } from '@kb-labs/core-platform';
import { access, cp, mkdtemp, mkdir, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createProjectRegistry } from '@kb-labs/core-project-registry';
import { SessionManager } from '@kb-labs/sdk/gateway';

const CLI_CHILD_PROCESS_TIMEOUT_MS = 60_000;

async function writeTestPlatformReceipt(platformRoot: string): Promise<void> {
  const receiptPath = path.join(platformRoot, '.kb', 'v2', 'receipt.json');
  const gatewayUrl = process.env.KB_GATEWAY_URL ?? `http://127.0.0.1:${process.env.GATEWAY_PORT ?? '4000'}`;
  await mkdir(path.dirname(receiptPath), { recursive: true });
  await writeFile(receiptPath, JSON.stringify({
    id: 'test-receipt',
    installationId: 'test-installation',
    plan: {
      request: { gatewayUrl },
      serviceGraph: { platformVersion: '2.120.1' },
    },
    verification: { hostHealthUrl: `${gatewayUrl}/health` },
  }));
}

async function writeInstalledAdapterLock(
  platformRoot: string,
  workspaceRoot: string,
  packageNames: readonly string[],
): Promise<Record<string, unknown>> {
  const installedPackageRoot = path.join(platformRoot, 'node_modules', '@kb-labs');
  await mkdir(installedPackageRoot, { recursive: true });
  for (const packageName of packageNames) {
    await symlink(
      path.join(workspaceRoot, 'adapters', packageName.replace('@kb-labs/adapters-', '')),
      path.join(installedPackageRoot, packageName.slice('@kb-labs/'.length)),
      'dir',
    );
  }
  return Object.fromEntries(packageNames.map(packageName => [packageName, {
    version: '2.120.1',
    integrity: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    resolvedPath: path.relative(platformRoot, path.join(platformRoot, 'node_modules', packageName)),
    source: 'platform',
    enabled: true,
  }]));
}

describe('installed platform adapter defaults', () => {
  let tempRoot: string | undefined;
  let gatewayServer: Server | undefined;
  let primaryGatewayServer: Server | undefined;

  afterEach(async () => {
    if (gatewayServer?.listening) await new Promise<void>((resolve, reject) => gatewayServer!.close((error) => error ? reject(error) : resolve()));
    gatewayServer = undefined;
    if (primaryGatewayServer?.listening) await new Promise<void>((resolve, reject) => primaryGatewayServer!.close((error) => error ? reject(error) : resolve()));
    primaryGatewayServer = undefined;
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  });

  // case: S-041.17, S-007.4
  it('requires a session for secured setup, then gates anonymous commands before project lookup', async () => {
    const workspaceRoot = path.resolve(process.cwd(), '../..');
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'kb-cli-secured-auth-order-'));
    const platformRoot = path.join(tempRoot, 'platform');
    const home = path.join(tempRoot, 'home');
    const registeredProject = path.join(tempRoot, 'registered-project');
    const unregisteredProject = path.join(tempRoot, 'unregistered-project');
    const authRequests: string[] = [];
    await Promise.all([
      mkdir(path.join(platformRoot, '.kb'), { recursive: true }),
      mkdir(home, { recursive: true }),
      mkdir(registeredProject, { recursive: true }),
      mkdir(unregisteredProject, { recursive: true }),
    ]);
    await writeTestPlatformReceipt(platformRoot);
    await writeFile(path.join(platformRoot, '.kb', 'kb.config.jsonc'), JSON.stringify({
      gateway: { access: { mode: 'secured' } },
      platform: { adapters: {} },
    }));
    const session = createServer((request, response) => {
      authRequests.push(`${request.method} ${request.url}`);
      response.setHeader('content-type', 'application/json');
      if (request.url === '/auth/me' && request.method === 'GET') {
        response.end(JSON.stringify({ ok: true, data: { email: 'admin@example.test', tenantId: 'test' } }));
        return;
      }
      if (request.url === '/auth/logout/cli' && request.method === 'POST') {
        response.end(JSON.stringify({ ok: true, data: {} }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ ok: false, error: { code: 'KB_RUNTIME_RESOURCE_NOT_FOUND', message: 'not found' } }));
    });
    gatewayServer = session;
    await new Promise<void>((resolve) => session.listen(0, '127.0.0.1', resolve));
    const gatewayUrl = `http://127.0.0.1:${(session.address() as AddressInfo).port}`;
    const expectedAuthFailure = createErrorEnvelope('KB_AUTH_REQUIRED', { details: { gatewayUrl } });

    const cliPath = path.join(workspaceRoot, 'cli/bin/dist/bin.js');
    const env: NodeJS.ProcessEnv = {
      ...process.env, HOME: home, KB_PLATFORM_ROOT: platformRoot, KB_GATEWAY_URL: gatewayUrl,
      KB_DIAGNOSTICS: 'agent', KB_LOG_LEVEL: 'warn',
    };
    delete env.KB_HOME;
    delete env.KB_NET_OFFSET;
    delete env.KB_PROJECT_ROOT;
    delete env.KB_PROJECT_ID;
    const run = (args: string[], cwd: string) => new Promise<{
      status: number | null; stdout: string; stderr: string; error?: Error;
    }>((resolve) => {
      const child = spawn(process.execPath, [cliPath, '--gateway-url', gatewayUrl, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, CLI_CHILD_PROCESS_TIMEOUT_MS);
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
      child.once('error', (error) => {
        clearTimeout(timer);
        resolve({ status: null, stdout, stderr, error });
      });
      child.once('close', (status) => {
        clearTimeout(timer);
        resolve({ status, stdout, stderr, ...(timedOut ? { error: new Error('CLI child timed out') } : {}) });
      });
      child.stdin.end();
    });
    await new SessionManager(path.join(home, '.kb', 'session.json')).save({
      gatewayUrl, accessToken: 'fixture-access', refreshToken: 'fixture-refresh',
      expiresAt: Date.now() + 900_000, email: 'admin@example.test', tenantId: 'test',
    });
    const projectAdd = await run(['project', 'add', registeredProject, '--json'], registeredProject);
    expect(projectAdd.status, JSON.stringify({ error: projectAdd.error?.message, stdout: projectAdd.stdout, stderr: projectAdd.stderr, authRequests })).toBe(0);
    const projectList = await run(['project', 'list', '--json'], registeredProject);
    expect(projectList.status, projectList.stderr || projectList.stdout).toBe(0);
    const registeredPaths: string[] = JSON.parse(projectList.stdout).data.projects.map((entry: { path: string }) => entry.path);
    expect(registeredPaths).toContain(await realpath(registeredProject));
    expect(registeredPaths).not.toContain(await realpath(unregisteredProject));
    const listingResult = await run(['registry', 'commands', '--json'], registeredProject);
    expect(listingResult.status, listingResult.stderr || listingResult.stdout).toBe(0);
    const listing = JSON.parse(listingResult.stdout) as {
      data: { commands: Array<{ path: string[]; protectionClass: string; requiresSession: boolean; available: boolean }> };
    };
    const representatives = new Map<string, string[]>();
    const registeredClasses = new Set<string>();
    for (const command of listing.data.commands) {
      if (!command.requiresSession) continue;
      registeredClasses.add(command.protectionClass);
      if (command.available && !representatives.has(command.protectionClass)) representatives.set(command.protectionClass, command.path);
    }
    expect([...registeredClasses].sort()).toEqual([...representatives.keys()].sort());
    expect(listing.data.commands.find((command) => command.path.join(' ') === 'registry commands')).toMatchObject({
      protectionClass: 'session:system', requiresSession: true,
    });
    const logout = await run(['auth', 'logout', '--json'], registeredProject);
    expect(logout.status, logout.stderr || logout.stdout).toBe(0);
    expect(authRequests.filter((entry) => entry === 'GET /auth/me')).toHaveLength(3);
    expect(authRequests).toContain('POST /auth/logout/cli');

    const anonymousProject = path.join(tempRoot, 'new-project');
    const anonymousProjectAdd = await run(['project', 'add', anonymousProject, '--json'], unregisteredProject);
    expect(anonymousProjectAdd.status, anonymousProjectAdd.stderr || anonymousProjectAdd.stdout).toBe(1);
    expect(JSON.parse(anonymousProjectAdd.stdout)).toMatchObject({ ok: false, error: {
      code: 'KB_AUTH_REQUIRED',
      message: expectedAuthFailure.message,
      hint: expectedAuthFailure.hint,
    } });
    const projectAddContext = JSON.parse(anonymousProjectAdd.stderr.slice(anonymousProjectAdd.stderr.indexOf('{'))) as { correlationId: string };
    expect(anonymousProjectAdd.stderr.match(/CLI resolved invocation context/g)).toHaveLength(1);
    expect((JSON.parse(anonymousProjectAdd.stdout) as { error: { correlationId: string } }).error.correlationId)
      .toBe(projectAddContext.correlationId);
    await expect(access(anonymousProject)).rejects.toThrow();

    for (const cwd of [registeredProject, unregisteredProject]) {
      for (const command of representatives.values()) {
        const args = [...command, '--json'];
        const result = await run(args, cwd);
        expect(result.error?.message, result.stderr || result.stdout).toBeUndefined();
        expect(result.status, result.stderr || result.stdout).toBe(1);
        const payload = JSON.parse(result.stdout);
        expect(payload).toMatchObject({ ok: false, error: {
          code: 'KB_AUTH_REQUIRED',
          message: expectedAuthFailure.message,
          hint: expectedAuthFailure.hint,
        } });
        expect(result.stderr).toContain('CLI resolved invocation context');
        expect(result.stderr.match(/CLI resolved invocation context/g)).toHaveLength(1);
        expect(result.stderr).toContain('"accessMode":"secured"');
        expect(result.stderr).toContain(`"platformConfigSource":"${path.join(platformRoot, '.kb', 'kb.config.jsonc')}"`);
        const contextRecord = JSON.parse(result.stderr.slice(result.stderr.indexOf('{'))) as { correlationId: string };
        expect(contextRecord.correlationId).toBeTypeOf('string');
        expect((payload as { error: { correlationId: string } }).error.correlationId).toBe(contextRecord.correlationId);
      }
    }
  }, CLI_CHILD_PROCESS_TIMEOUT_MS * 2);

  // case: S-124.1, S-124.9
  it('manages the project registry from an unregistered working directory', async () => {
    const workspaceRoot = path.resolve(process.cwd(), '../..');
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'kb-cli-platform-scope-'));
    const platformRoot = path.join(tempRoot, 'platform');
    const projectRoot = path.join(tempRoot, 'unregistered-project');
    const home = path.join(tempRoot, 'home');
    await Promise.all([
      mkdir(path.join(platformRoot, '.kb'), { recursive: true }),
      mkdir(projectRoot, { recursive: true }),
      mkdir(home, { recursive: true }),
    ]);
    await writeTestPlatformReceipt(platformRoot);
    await writeFile(path.join(platformRoot, '.kb', 'kb.config.json'), JSON.stringify({
      gateway: { access: { mode: 'local' } },
      platform: { adapters: {} },
    }));

    const result = spawnSync(process.execPath, [path.join(workspaceRoot, 'cli/bin/dist/bin.js'), 'project', 'list', '--json'], {
      cwd: projectRoot,
      env: { ...process.env, HOME: home, KB_HOME: home, KB_PLATFORM_ROOT: platformRoot },
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    const payload: unknown = JSON.parse(result.stdout);
    const findProjects = (value: unknown): unknown[] | undefined => {
      if (Array.isArray(value)) return value.flatMap((item) => {
        const found = findProjects(item);
        return found === undefined ? [] : [found];
      })[0] as unknown[] | undefined;
      if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        if (Array.isArray(record.projects)) return record.projects;
        for (const child of Object.values(record)) {
          const found = findProjects(child);
          if (found !== undefined) return found;
        }
      }
      return undefined;
    };
    expect(findProjects(payload)).toEqual([]);

    const target = path.join(tempRoot, 'registered-project');
    await mkdir(target);
    const add = spawnSync(process.execPath, [path.join(workspaceRoot, 'cli/bin/dist/bin.js'), 'project', 'add', target, '--json'], {
      cwd: projectRoot,
      env: { ...process.env, HOME: home, KB_HOME: home, KB_PLATFORM_ROOT: platformRoot },
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(add.status, add.stderr || add.stdout).toBe(0);
    expect(add.stdout).toContain(path.resolve(target));
    await expect(access(path.join(target, '.kb'))).rejects.toThrow();
    expect(await readdir(projectRoot)).toEqual([]);
  });

  // case: S-054.12, S-054.17, PC-001.12
  // case: S-203.1
  it('runs adapter list with the sealed release config and installed adapter lock', async () => {
    const workspaceRoot = path.resolve(process.cwd(), '../..');
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'kb-cli-installed-defaults-'));
    const platformRoot = path.join(tempRoot, 'platform');
    const primaryPlatformRoot = path.join(tempRoot, 'primary-platform');
    const projectRoot = path.join(tempRoot, 'project');
    const home = path.join(tempRoot, 'home');
    const dataRoot = path.join(tempRoot, 'state', 'data');
    await Promise.all([
      mkdir(path.join(platformRoot, '.kb', 'v2'), { recursive: true }),
      mkdir(dataRoot, { recursive: true }),
      mkdir(path.join(primaryPlatformRoot, '.kb', 'v2'), { recursive: true }),
      mkdir(projectRoot, { recursive: true }),
      mkdir(home, { recursive: true }),
    ]);
    await writeFile(
      path.join(platformRoot, '.kb', 'v2', 'platform-layout.json'),
      await readFile(path.join(workspaceRoot, 'tools/kb-create/v2/contracts/platform-layout.json')),
    );
    await symlink(dataRoot, path.join(platformRoot, '.kb', 'data'), 'dir');

    primaryGatewayServer = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/health/identity') {
        response.end(JSON.stringify({ ok: true, data: { installationId: 'installed-root-a' } }));
        return;
      }
      if (request.url === '/health/adapters') {
        response.end(JSON.stringify({ ok: true, data: [
          { slot: 'storage', mode: 'real', implementation: '@kb-labs/adapters-primary' },
        ] }));
        return;
      }
      response.statusCode = 404;
      response.end('{}');
    });
    await new Promise<void>((resolve) => primaryGatewayServer!.listen(0, '127.0.0.1', resolve));
    const primaryGatewayPort = (primaryGatewayServer.address() as AddressInfo).port;
    await writeFile(path.join(primaryPlatformRoot, '.kb', 'v2', 'receipt.json'), JSON.stringify({
      installationId: 'installed-root-a', verification: { hostHealthUrl: `http://127.0.0.1:${primaryGatewayPort}/health` },
      plan: { serviceGraph: { platformVersion: '2.120.1' } },
    }));

    gatewayServer = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/health/identity') {
        response.end(JSON.stringify({ ok: true, data: { installationId: 'installed-root-b' } }));
        return;
      }
      if (request.url === '/health/adapters') {
        response.end(JSON.stringify({ ok: true, data: [
          { slot: 'storage', mode: 'real', implementation: '@kb-labs/adapters-fs' },
          { slot: 'kvStore', mode: 'real', implementation: '@kb-labs/adapters-sqlite/kv' },
          { slot: 'llm', mode: 'real', implementation: '@kb-labs/adapters-openai' },
        ] }));
        return;
      }
      response.statusCode = 404;
      response.end('{}');
    });
    await new Promise<void>((resolve) => gatewayServer!.listen(0, '127.0.0.1', resolve));
    const gatewayPort = (gatewayServer.address() as AddressInfo).port;
    await mkdir(path.join(platformRoot, '.kb', 'v2'), { recursive: true });
    const unifiedVersion = '2.120.2-cand.d84c8f013160';
    const receiptPath = path.join(platformRoot, '.kb', 'v2', 'receipt.json');
    await writeFile(receiptPath, JSON.stringify({
      installationId: 'installed-root-b', verification: { hostHealthUrl: `http://127.0.0.1:${gatewayPort}/health` },
      plan: { serviceGraph: { platformVersion: unifiedVersion } },
    }));

    const configPath = path.join(workspaceRoot, '.kb', 'kb.config.jsonc');
    const workspaceConfig = await readFile(configPath, 'utf8');
    const releaseConfig = workspaceConfig.replace(/"mode":\s*"development",\s*/, '');
    await writeFile(path.join(platformRoot, '.kb', 'kb.config.jsonc'), releaseConfig);

    const config = JSON.parse(releaseConfig.replace(/,\s*([}\]])/g, '$1')) as {
      platform: { adapters: Record<string, string>; adapterOptions?: Record<string, unknown> };
      gateway?: { access?: { mode?: string }; [key: string]: unknown };
    };
    config.gateway = { ...config.gateway, access: { ...config.gateway?.access, mode: 'local' } };
    delete config.platform.adapters.storage;
    if (config.platform.adapterOptions) delete config.platform.adapterOptions.storage;
    await writeFile(path.join(platformRoot, '.kb', 'kb.config.jsonc'), `${JSON.stringify(config, null, 2)}\n`);
    const packages = [...new Set([
      ...Object.values(config.platform.adapters).map(value => value.split('/').slice(0, 2).join('/')),
      '@kb-labs/adapters-openai',
      '@kb-labs/adapters-fs',
    ])];
    const adapters = await writeInstalledAdapterLock(platformRoot, workspaceRoot, packages);
    await writeFile(path.join(platformRoot, '.kb', 'marketplace.lock'), JSON.stringify({
      schema: 'kb.marketplace/3', plugins: {}, adapters,
    }));

    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, KB_HOME: path.join(home, '.kb'), KB_PLATFORM_ROOT: platformRoot, KB_PROJECT_ROOT: projectRoot };
    delete env.KB_NET_OFFSET;
    delete env.KB_GATEWAY_URL;
    delete env.GATEWAY_PORT;
    delete env.GATEWAY_HOST;
    const help = spawnSync(process.execPath, [path.join(workspaceRoot, 'cli/bin/dist/bin.js'), '--help'], {
      cwd: projectRoot,
      env,
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(help.status, help.stderr || help.stdout).toBe(0);
    expect(help.stdout).toContain('KB Labs CLI');
    expect(await readdir(projectRoot)).toEqual([]);
    await expect(access(path.join(projectRoot, '.kb'))).rejects.toThrow();
    await expect(access(path.join(env.KB_HOME!, 'state'))).rejects.toThrow();

    const version = spawnSync(process.execPath, [path.join(workspaceRoot, 'cli/bin/dist/bin.js'), '--version'], {
      cwd: projectRoot,
      env,
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(version.status, version.stderr || version.stdout).toBe(0);
    expect(version.stdout.trim()).toBe(unifiedVersion);

    for (const args of [['--version', '--json'], ['--json', '--version']]) {
      const globalVersionJSON = spawnSync(process.execPath, [path.join(workspaceRoot, 'cli/bin/dist/bin.js'), ...args], {
        cwd: projectRoot,
        env,
        encoding: 'utf8',
        timeout: 30_000,
      });
      expect(globalVersionJSON.status, globalVersionJSON.stderr || globalVersionJSON.stdout).toBe(0);
      expect(JSON.stringify(JSON.parse(globalVersionJSON.stdout))).toContain(unifiedVersion);
    }

    const versionJSON = spawnSync(process.execPath, [path.join(workspaceRoot, 'cli/bin/dist/bin.js'), 'version', '--json'], {
      cwd: projectRoot,
      env,
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(versionJSON.status, versionJSON.stderr || versionJSON.stdout).toBe(0);
    expect(JSON.stringify(JSON.parse(versionJSON.stdout))).toContain(unifiedVersion);

    const unavailableReceipt = `${receiptPath}.unavailable`;
    await rename(receiptPath, unavailableReceipt);
    try {
      const expectedVersionError = createErrorEnvelope('KB_CLI_PLATFORM_VERSION_UNAVAILABLE');
      for (const args of [['--version', '--json'], ['--json', '--version'], ['version', '--json']]) {
        const missingVersion = spawnSync(process.execPath, [path.join(workspaceRoot, 'cli/bin/dist/bin.js'), ...args], {
          cwd: projectRoot,
          env,
          encoding: 'utf8',
          timeout: 30_000,
        });
        expect(missingVersion.status, missingVersion.stderr || missingVersion.stdout).not.toBe(0);
        expect(JSON.parse(missingVersion.stdout)).toMatchObject({
          ok: false,
          error: {
            code: expectedVersionError.code,
            message: expectedVersionError.message,
            hint: expectedVersionError.hint,
          },
        });
      }
    } finally {
      await rename(unavailableReceipt, receiptPath);
    }
    await createProjectRegistry({ env }).add(projectRoot);

    const command = await spawnCli(process.execPath, [path.join(workspaceRoot, 'cli/bin/dist/bin.js'), 'adapter', 'list', '--json'], {
      cwd: projectRoot,
      env,
    });

    expect(command.status, command.stderr || command.stdout).toBe(0);
    const payload = JSON.parse(command.stdout) as { ok?: boolean; data?: { adapters?: Array<{ slot: string; mode: string; implementation: string; baseDir?: string }> } };
    expect(payload.ok).toBe(true);
    expect(payload.data?.adapters?.find(row => row.slot === 'kvStore')).toMatchObject({
      mode: 'real', implementation: '@kb-labs/adapters-sqlite/kv',
    });
    const storage = payload.data?.adapters?.find(row => row.slot === 'storage');
    expect(storage).toMatchObject({ mode: 'real', implementation: '@kb-labs/adapters-fs' });
    expect(storage?.implementation).not.toBe('@kb-labs/adapters-primary');
    const stateRoot = path.join(env.KB_HOME!, 'state');
    expect(path.relative(stateRoot, storage?.baseDir ?? '')).toMatch(/^prj_[0-9a-f]{16}\/storage$/);
    expect(path.relative(projectRoot, storage?.baseDir ?? '').startsWith('..')).toBe(true);
    expect(payload.data?.adapters?.find(row => row.slot === 'llm')).toMatchObject({
      mode: 'real', implementation: '@kb-labs/adapters-openai',
      credentialsStatus: 'missing', missingCredentials: ['OPENAI_API_KEY'],
    });

    await new Promise<void>((resolve, reject) => gatewayServer!.close((error) => error ? reject(error) : resolve()));
    gatewayServer = undefined;
    const stopped = await spawnCli(process.execPath, [path.join(workspaceRoot, 'cli/bin/dist/bin.js'), 'adapter', 'list', '--json'], {
      cwd: projectRoot,
      env,
    });
    expect(stopped.status, stopped.stderr || stopped.stdout).toBe(0);
    const stoppedPayload = JSON.parse(stopped.stdout) as {
      data?: { adapters?: Array<{ slot: string; runtimeStatus?: string; action?: { command: string } }> };
    };
    expect(stoppedPayload.data?.adapters?.find(row => row.slot === 'storage')).toMatchObject({
      runtimeStatus: 'unknown',
      action: { command: `kb-create start --platform-root ${JSON.stringify(platformRoot)}` },
    });
  });

  // case: S-204.1, S-204.2, S-204.8, S-204.9, S-204.10, S-204.11
  // case: S-054.21, S-054.22
  it('resolves configured adapter paths from the shared platform data root for system and plugin commands', async () => {
    const workspaceRoot = path.resolve(process.cwd(), '../..');
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'kb-cli-platform-data-root-'));
    const installRoot = path.join(tempRoot, 'install');
    const versionRoot = path.join(installRoot, 'versions', 'v1');
    const platformRoot = path.join(installRoot, 'current');
    const installedCommitRoot = path.join(versionRoot, 'plugins', 'commit');
    const projectRoot = path.join(tempRoot, 'project');
    const secondProjectRoot = path.join(tempRoot, 'project-b');
    const home = path.join(tempRoot, 'home');
    const dataRoot = path.join(installRoot, 'state', 'data');
    await Promise.all([
      mkdir(path.join(versionRoot, '.kb', 'v2'), { recursive: true }),
      mkdir(path.join(versionRoot, 'node_modules', '@kb-labs'), { recursive: true }),
      mkdir(path.join(installedCommitRoot, 'node_modules', '@kb-labs'), { recursive: true }),
      mkdir(dataRoot, { recursive: true }),
      mkdir(projectRoot, { recursive: true }),
      mkdir(secondProjectRoot, { recursive: true }),
      mkdir(home, { recursive: true }),
    ]);
    await symlink(
      path.join(workspaceRoot, 'sdk/sdk'),
      path.join(versionRoot, 'node_modules', '@kb-labs', 'sdk'),
      'dir',
    );
    await symlink(
      path.join(versionRoot, 'node_modules', '@kb-labs', 'sdk'),
      path.join(installedCommitRoot, 'node_modules', '@kb-labs', 'sdk'),
      'dir',
    );
    await symlink(
      path.join(workspaceRoot, 'plugins/commit/src/core'),
      path.join(installedCommitRoot, 'node_modules', '@kb-labs', 'commit-core'),
      'dir',
    );
    const initialized = spawnSync('git', ['init', '--quiet', projectRoot], { encoding: 'utf8' });
    expect(initialized.status, initialized.stderr).toBe(0);
    const gitRepositories = new Set([projectRoot]);
    await symlink(versionRoot, platformRoot, 'dir');
    await writeFile(
      path.join(versionRoot, '.kb', 'v2', 'platform-layout.json'),
      await readFile(path.join(workspaceRoot, 'tools/kb-create/v2/contracts/platform-layout.json')),
    );
    await symlink(path.relative(path.join(versionRoot, '.kb'), dataRoot), path.join(versionRoot, '.kb', 'data'), 'dir');

    gatewayServer = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/health') {
        response.end(JSON.stringify({ ok: true, data: { status: 'healthy' } }));
        return;
      }
      if (request.url === '/health/identity') {
        response.end(JSON.stringify({ ok: true, data: { installationId: 'platform-data-root-test' } }));
        return;
      }
      if (request.url === '/health/adapters') {
        response.end(JSON.stringify({ ok: true, data: [] }));
        return;
      }
      response.statusCode = 404;
      response.end('{}');
    });
    await new Promise<void>((resolve) => gatewayServer!.listen(0, '127.0.0.1', resolve));
    const gatewayPort = (gatewayServer.address() as AddressInfo).port;
    await writeFile(path.join(versionRoot, '.kb', 'v2', 'receipt.json'), JSON.stringify({
      installationId: 'platform-data-root-test',
      verification: { hostHealthUrl: `http://127.0.0.1:${gatewayPort}/health` },
      plan: { serviceGraph: { platformVersion: '2.120.1' } },
    }));

    const configPath = path.join(versionRoot, '.kb', 'kb.config.jsonc');
    const config = {
      gateway: { access: { mode: 'local' } },
      execution: { mode: 'in-process' },
      platform: {
        adapters: {
          storage: '@kb-labs/adapters-fs',
          cache: '@kb-labs/adapters-state-broker',
          eventBus: '@kb-labs/adapters-eventbus-cache',
          documentDatabase: '@kb-labs/adapters-sqlite',
          kvStore: '@kb-labs/adapters-sqlite/kv',
          analytics: '@kb-labs/adapters-analytics-sqlite',
          logger: '@kb-labs/adapters-pino',
          logRingBuffer: '@kb-labs/adapters-log-ringbuffer',
          logPersistence: '@kb-labs/adapters-log-document',
        },
        adapterOptions: {
          storage: { baseDir: 'storage' },
          documentDatabase: { filename: 'database/kb.sqlite' },
          kvStore: { filename: 'database/kb.sqlite' },
          analytics: { dbPath: 'analytics/analytics.sqlite' },
        },
      },
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const adapterPackages = [
      '@kb-labs/adapters-fs',
      '@kb-labs/adapters-state-broker',
      '@kb-labs/adapters-eventbus-cache',
      '@kb-labs/adapters-sqlite',
      '@kb-labs/adapters-analytics-sqlite',
      '@kb-labs/adapters-pino',
      '@kb-labs/adapters-log-ringbuffer',
      '@kb-labs/adapters-log-document',
      '@kb-labs/adapters-openai',
    ];
    const adapters = await writeInstalledAdapterLock(platformRoot, workspaceRoot, adapterPackages);
    const commitRoot = path.join(workspaceRoot, 'plugins/commit');
    const commitPackageJSON = await readFile(path.join(commitRoot, 'package.json'));
    await cp(path.join(commitRoot, 'dist'), path.join(installedCommitRoot, 'dist'), { recursive: true });
    await writeFile(path.join(installedCommitRoot, 'package.json'), commitPackageJSON);
    expect(await realpath(path.join(installedCommitRoot, 'node_modules', '@kb-labs', 'sdk')))
      .toBe(await realpath(path.join(versionRoot, 'node_modules', '@kb-labs', 'sdk')));
    const commitPackage = JSON.parse(commitPackageJSON.toString('utf8')) as {
      version: string;
      dependencies: Record<string, string>;
    };
    for (const dependency of Object.keys(commitPackage.dependencies)) {
      const dependencyPath = path.join(installedCommitRoot, 'node_modules', dependency);
      try {
        await access(dependencyPath);
        continue;
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      await mkdir(path.dirname(dependencyPath), { recursive: true });
      await symlink(path.join(commitRoot, 'node_modules', dependency), dependencyPath, 'dir');
    }
    await writeFile(path.join(versionRoot, '.kb', 'marketplace.lock'), JSON.stringify({
      schema: 'kb.marketplace/3',
      plugins: {
        '@kb-labs/commit': {
          version: commitPackage.version,
          integrity: `sha256-${createHash('sha256').update(commitPackageJSON).digest('base64')}`,
          package: '@kb-labs/commit',
          resolvedPath: path.relative(versionRoot, installedCommitRoot),
          source: 'platform',
          enabled: true,
        },
      },
      adapters,
    }));

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      KB_HOME: path.join(home, '.kb'),
      KB_PLATFORM_ROOT: platformRoot,
      KB_PROJECT_ROOT: projectRoot,
    };
    delete env.KB_NET_OFFSET;
    env.KB_GATEWAY_URL = `http://127.0.0.1:${gatewayPort}`;
    env.NODE_ENV = 'production';
    const cliPath = path.join(workspaceRoot, 'cli/bin/dist/bin.js');
    const projectGit = spawnSync('git', ['init', '--quiet', projectRoot], { encoding: 'utf8' });
    expect(projectGit.status, projectGit.stderr).toBe(0);
    const projectTreeBefore = await snapshotRepositoryTree(projectRoot);
    const secondProjectTreeBefore = await snapshotRepositoryTree(secondProjectRoot);
    const assertRepositoriesUnchanged = async (): Promise<void> => {
      await expect(access(path.join(projectRoot, '.kb'))).rejects.toThrow();
      await expect(access(path.join(secondProjectRoot, '.kb'))).rejects.toThrow();
      expect(await snapshotRepositoryTree(projectRoot)).toEqual(projectTreeBefore);
      expect(await snapshotRepositoryTree(secondProjectRoot)).toEqual(secondProjectTreeBefore);
      for (const repository of [projectRoot, secondProjectRoot]) {
        if (!gitRepositories.has(repository)) continue;
        const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
          cwd: repository, env, encoding: 'utf8',
        });
        expect(status.status, status.stderr).toBe(0);
        expect(status.stdout).toBe('');
      }
    };
    const runRepositoryCommand = async (cwd: string, args: string[]): Promise<void> => {
      const result = spawnSync(process.execPath, [cliPath, ...args], {
        cwd, env, encoding: 'utf8', timeout: CLI_CHILD_PROCESS_TIMEOUT_MS,
      });
      expect(result.status, `${args.join(' ')}\n${result.stderr || result.stdout}`).toBe(0);
      await assertRepositoriesUnchanged();
    };

    // Replay the S-204 settings flow in its recorded order. Snapshot both repos
    // after every invocation so the first writer is attributed to its command.
    await runRepositoryCommand(projectRoot, ['project', 'add', projectRoot, '--json']);
    const secondProjectGit = spawnSync('git', ['init', '--quiet', secondProjectRoot], { encoding: 'utf8' });
    expect(secondProjectGit.status, secondProjectGit.stderr).toBe(0);
    gitRepositories.add(secondProjectRoot);
    await assertRepositoriesUnchanged();
    await runRepositoryCommand(secondProjectRoot, ['project', 'add', secondProjectRoot, '--json']);
    await runRepositoryCommand(projectRoot, ['config', 'get', 'plugins.commit.llm.maxTokens', '--json']);
    await runRepositoryCommand(projectRoot, ['config', 'set', '--scope', 'platform', 'plugins.commit.llm.maxTokens', '1900', '--json']);
    await runRepositoryCommand(secondProjectRoot, ['config', 'get', 'plugins.commit.llm.maxTokens', '--json']);
    await runRepositoryCommand(projectRoot, ['config', 'set', 'plugins.commit.llm.maxTokens', '1800', '--json']);
    await runRepositoryCommand(projectRoot, ['config', 'get', 'plugins.commit.llm.maxTokens', '--json']);
    await runRepositoryCommand(projectRoot, ['config', 'set', '--scope', 'platform', 'plugins.commit.scope.scopes', '[{"id":"journey-shared","label":"Shared","path":"."}]', '--json']);
    await runRepositoryCommand(projectRoot, ['config', 'set', 'plugins.commit.scope.scopes', '[{"id":"journey-a","label":"Project A","path":"."}]', '--json']);
    await runRepositoryCommand(projectRoot, ['config', 'get', 'plugins.commit.scope.scopes', '--json']);
    await runRepositoryCommand(secondProjectRoot, ['config', 'get', 'plugins.commit.scope.scopes', '--json']);

    const treeBefore = await snapshotRepositoryTree(projectRoot);
    const statusBefore = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: projectRoot, env, encoding: 'utf8',
    }).stdout;

    const systemCommand = spawnSync(process.execPath, [cliPath, 'adapter', 'list', '--json'], {
      cwd: projectRoot, env, encoding: 'utf8', timeout: CLI_CHILD_PROCESS_TIMEOUT_MS,
    });
    expect(systemCommand.status, systemCommand.stderr || systemCommand.stdout).toBe(0);
    const canonicalDataRoot = await realpath(dataRoot);
    expect(await realpath(path.join(dataRoot, 'database', 'kb.sqlite'))).toBe(path.join(canonicalDataRoot, 'database', 'kb.sqlite'));
    expect(await realpath(path.join(dataRoot, 'analytics', 'analytics.sqlite'))).toBe(path.join(canonicalDataRoot, 'analytics', 'analytics.sqlite'));
    expect(await snapshotRepositoryTree(projectRoot)).toEqual(treeBefore);
    expect(spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: projectRoot, env, encoding: 'utf8' }).stdout)
      .toBe(statusBefore);

    for (const suffix of ['database/kb.sqlite', 'database/kb.sqlite-wal', 'database/kb.sqlite-shm', 'analytics/analytics.sqlite', 'analytics/analytics.sqlite-wal', 'analytics/analytics.sqlite-shm']) {
      await rm(path.join(dataRoot, suffix), { force: true });
    }
    // This offline fixture has no installed host. Skip the receipt's live
    // Gateway identity check so the project plugin handler runs in-process.
    await rm(path.join(versionRoot, '.kb', 'v2', 'receipt.json'));
    const pluginEnv = { ...env };
    delete pluginEnv.KB_GATEWAY_URL;
    const pluginCommand = spawnSync(process.execPath, [cliPath, 'commit', 'plan', 'delete', '--json'], {
      cwd: projectRoot, env: pluginEnv, encoding: 'utf8', timeout: CLI_CHILD_PROCESS_TIMEOUT_MS,
    });
    expect(pluginCommand.status, pluginCommand.stderr || pluginCommand.stdout).toBe(0);
    expect(JSON.parse(pluginCommand.stdout)).toMatchObject({ ok: true });
    expect(await realpath(path.join(dataRoot, 'database', 'kb.sqlite'))).toBe(path.join(canonicalDataRoot, 'database', 'kb.sqlite'));
    expect(await realpath(path.join(dataRoot, 'analytics', 'analytics.sqlite'))).toBe(path.join(canonicalDataRoot, 'analytics', 'analytics.sqlite'));
    expect(await snapshotRepositoryTree(projectRoot)).toEqual(treeBefore);
    expect(spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: projectRoot, env, encoding: 'utf8' }).stdout)
      .toBe(statusBefore);

    for (const invalidPath of ['.kb/database/kb.sqlite', '../outside.sqlite']) {
      config.platform.adapterOptions.documentDatabase.filename = invalidPath;
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
      const invalid = spawnSync(process.execPath, [cliPath, 'adapter', 'list', '--json'], {
        cwd: projectRoot, env, encoding: 'utf8', timeout: CLI_CHILD_PROCESS_TIMEOUT_MS,
      });
      expect(invalid.status).not.toBe(0);
      expect(invalid.stdout).toContain('KB_CONFIG_INVALID');
      expect(invalid.stdout).toContain(invalidPath.startsWith('.kb/') ? 'database/kb.sqlite' : 'outside.sqlite');
      expect(await snapshotRepositoryTree(projectRoot)).toEqual(treeBefore);
    }
  }, CLI_CHILD_PROCESS_TIMEOUT_MS * 2);

  // case: S-203.1
  it('keeps discovery diagnostics off JSON stdout', async () => {
    const workspaceRoot = path.resolve(process.cwd(), '../..');
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'kb-cli-json-discovery-diagnostic-'));
    const platformRoot = path.join(tempRoot, 'platform');
    const projectRoot = path.join(tempRoot, 'project');
    const home = path.join(tempRoot, 'home');
    await Promise.all([mkdir(projectRoot), mkdir(home)]);
    await mkdir(path.join(platformRoot, '.kb'), { recursive: true });
    await mkdir(path.join(platformRoot, '.kb', 'data'), { recursive: true });
    await mkdir(path.join(platformRoot, '.kb', 'v2'), { recursive: true });
    await writeFile(
      path.join(platformRoot, '.kb', 'v2', 'platform-layout.json'),
      await readFile(path.join(workspaceRoot, 'tools/kb-create/v2/contracts/platform-layout.json')),
    );
    await mkdir(path.join(projectRoot, '.kb'));
    const workspaceConfig = await readFile(path.join(workspaceRoot, '.kb', 'kb.config.jsonc'), 'utf8');
    const releaseConfig = workspaceConfig.replace(/"mode":\s*"development",\s*/, '');
    const config = JSON.parse(releaseConfig.replace(/,\s*([}\]])/g, '$1')) as {
      platform: { adapters: Record<string, string>; adapterOptions?: Record<string, unknown> };
      gateway?: { access?: { mode?: string }; [key: string]: unknown };
    };
    config.gateway = { ...config.gateway, access: { ...config.gateway?.access, mode: 'local' } };
    delete config.platform.adapters.storage;
    if (config.platform.adapterOptions) delete config.platform.adapterOptions.storage;
    await writeFile(path.join(platformRoot, '.kb', 'kb.config.jsonc'), `${JSON.stringify(config, null, 2)}\n`);
    const packages = [...new Set([
      ...Object.values(config.platform.adapters).map(value => value.split('/').slice(0, 2).join('/')),
      '@kb-labs/adapters-openai',
      '@kb-labs/adapters-fs',
    ])];
    const adapters = await writeInstalledAdapterLock(platformRoot, workspaceRoot, packages);
    const commitPackageRoot = path.join(workspaceRoot, 'plugins/commit');
    const commitManifestModule = await import(pathToFileURL(path.join(commitPackageRoot, 'dist/manifest.js')).href) as {
      manifest: { id: string; version: string };
    };
    const commitPackageJSON = await readFile(path.join(commitPackageRoot, 'package.json'));
    const commitPackage = JSON.parse(commitPackageJSON.toString('utf8')) as { name: string; version: string };
    await mkdir(path.join(platformRoot, 'plugins'), { recursive: true });
    await symlink(commitPackageRoot, path.join(platformRoot, 'plugins', 'commit'), 'dir');
    const mismatchedPluginId = `${commitManifestModule.manifest.id}-fixture-mismatch`;
    await writeFile(path.join(platformRoot, '.kb', 'marketplace.lock'), JSON.stringify({
      schema: 'kb.marketplace/3',
      plugins: {
        [mismatchedPluginId]: {
          version: commitPackage.version,
          integrity: `sha256-${createHash('sha256').update(commitPackageJSON).digest('base64')}`,
          package: commitPackage.name,
          resolvedPath: 'plugins/commit',
          source: 'platform',
          enabled: true,
        },
      },
      adapters,
    }));

    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, KB_HOME: path.join(home, '.kb'), KB_PLATFORM_ROOT: platformRoot, KB_PROJECT_ROOT: projectRoot };
    delete env.KB_NET_OFFSET;
    await createProjectRegistry({ env }).add(projectRoot);
    const command = spawnSync(process.execPath, [path.join(workspaceRoot, 'cli/bin/dist/bin.js'), 'project', 'list', '--json'], {
      cwd: projectRoot,
      env,
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(command.status, command.stderr || command.stdout).toBe(0);
    const envelope = JSON.parse(command.stdout);
    expect(envelope).toMatchObject({ ok: true, data: expect.anything() });
    expect(command.stdout.trimEnd()).toBe(JSON.stringify(envelope));
    expect(command.stdout).not.toContain('[discover]');
    expect(command.stderr).toContain('PLUGIN_ID_MISMATCH');
  });
});

function spawnCli(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => child.kill('SIGTERM'), 30_000);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status) => {
      clearTimeout(timeout);
      resolve({ status, stdout, stderr });
    });
  });
}

async function snapshotRepositoryTree(root: string): Promise<Array<[string, string]>> {
  const entries: Array<[string, string]> = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute);
      if (entry.isDirectory()) {
        entries.push([`${relative}/`, 'directory']);
        await visit(absolute);
      } else if (entry.isSymbolicLink()) {
        entries.push([relative, `symlink:${await readlink(absolute)}`]);
      } else {
        entries.push([relative, (await readFile(absolute)).toString('base64')]);
      }
    }
  };
  await visit(root);
  return entries.sort(([left], [right]) => left.localeCompare(right));
}
