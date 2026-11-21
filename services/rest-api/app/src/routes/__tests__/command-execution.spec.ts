import Fastify from 'fastify';
import { mkdtemp, mkdir, symlink, writeFile, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IEntityRegistry, ManifestV3 } from '@kb-labs/plugin-contracts';
import { createProjectCommandExecutionProof, PROJECT_COMMAND_EXECUTION_PROOF_HEADER, PROJECT_RUNTIME_TOKEN_ENV } from '@kb-labs/shared-daemon';
import { registerProjectCommandExecutionRoute } from '../command-execution.js';

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('@kb-labs/core-runtime', () => ({
  platform: { executionBackend: { executionMode: 'worker-pool', execute } },
}));

const roots: string[] = [];
let app: ReturnType<typeof Fastify>;
let pluginRoot: string;
let registry: IEntityRegistry;
const runtimeToken = 'runtime-proof-test-secret-0123456789';
const manifest: ManifestV3 = {
  schema: 'kb.plugin/3', id: '@kb-labs/fixture', version: '1.2.3',
  configSection: 'commit',
  permissions: { quotas: { timeoutMs: 1500 } },
  cli: { commands: [{ path: 'commit preview', describe: 'fixture command', handler: './commands/run.js#default', flags: [{ name: 'dry-run', type: 'boolean' }, { name: 'secret', type: 'string', secret: true }], permissions: { quotas: { timeoutMs: 2000 } } }] },
};

async function setup(handler = manifest.cli!.commands[0]!.handler) {
  app = Fastify();
  pluginRoot = await mkdtemp(path.join(os.tmpdir(), 'project-command-'));
  roots.push(pluginRoot);
  await mkdir(path.join(pluginRoot, 'dist', 'commands'), { recursive: true });
  await writeFile(path.join(pluginRoot, 'dist', 'commands', 'run.js'), 'export default {}');
  const selectedManifest = { ...manifest, cli: { commands: [{ ...manifest.cli!.commands[0]!, handler }] } };
  registry = { snapshot: () => ({ partial: false, stale: false, manifests: [{ pluginId: '@kb-labs/fixture', manifest: selectedManifest, pluginRoot }] }) } as unknown as IEntityRegistry;
  await registerProjectCommandExecutionRoute(app, { registry, projectId: 'prj_fixture', projectRoot: pluginRoot, platformRoot: pluginRoot, runtimeToken });
  await app.ready();
}

function trustedHeaders(projectId = 'prj_fixture') {
  return { 'x-kb-project-id': projectId, [PROJECT_COMMAND_EXECUTION_PROOF_HEADER]: createProjectCommandExecutionProof(runtimeToken, { projectId, method: 'POST', path: '/api/v1/commands/execute' }) };
}

beforeEach(() => {
  execute.mockReset();
  execute.mockResolvedValue({ ok: true, data: { output: 'preview' } });
});
afterEach(async () => {
  await app?.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('project runtime command execution', () => {
  // case: S-160.1
  it('resolves the enabled command from the host catalog and executes it through the host backend', async () => {
    await setup();
    execute.mockImplementation(async (_request: unknown, options: { onLog: (entry: { stream: 'stderr'; message: string }) => void }) => {
      options.onLog({ stream: 'stderr', message: 'Analyzing changes...' });
      return { ok: true, data: { output: 'preview' } };
    });
    const response = await app.inject({
      method: 'POST', url: '/api/v1/commands/execute',
      headers: trustedHeaders(),
      payload: { requestId: 'request-test-160', pluginId: '@kb-labs/fixture', commandPath: 'commit preview', input: { argv: [], flags: { 'dry-run': true, json: true } } },
    });
    expect(response.statusCode).toBe(200);
    const events = response.body.trim().split('\n').map((line: string) => JSON.parse(line));
    expect(events[0]).toMatchObject({ type: 'execution:output', stream: 'stderr', data: expect.stringContaining('Executing @kb-labs/fixture') });
    expect(events[1]).toMatchObject({ type: 'execution:output', stream: 'stderr', data: 'Analyzing changes...\n' });
    expect(events.at(-1)).toMatchObject({
      type: 'execution:done', exitCode: 0,
      metadata: { result: { output: 'preview' }, executionOwner: 'project-runtime', projectId: 'prj_fixture', executionMode: 'worker-pool' },
    });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      descriptor: expect.objectContaining({ pluginId: '@kb-labs/fixture', hostType: 'cli', configSection: 'commit', permissions: { quotas: { timeoutMs: 2000 } } }),
      pluginRoot: await import('node:fs/promises').then(({ realpath }) => realpath(pluginRoot)),
      handlerRef: 'dist/commands/run.js',
      input: { argv: [], flags: { 'dry-run': true, json: true } },
      workspace: { cwd: pluginRoot },
    }), expect.objectContaining({ signal: expect.any(AbortSignal), onLog: expect.any(Function) }));
  });

  it('rejects direct listener access without proof from the runtime guard', async () => {
    await setup();
    const response = await app.inject({ method: 'POST', url: '/api/v1/commands/execute', headers: { 'x-kb-project-id': 'prj_fixture' }, payload: { requestId: 'request-direct', pluginId: '@kb-labs/fixture', commandPath: 'commit preview', input: { argv: [], flags: {} } } });
    expect(response.statusCode).toBe(403);
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects replaying a runtime guard proof on a second direct listener request', async () => {
    await setup();
    const headers = trustedHeaders();
    const payload = (requestId: string) => ({ requestId, pluginId: '@kb-labs/fixture', commandPath: 'commit preview', input: { argv: [], flags: {} } });
    const first = await app.inject({ method: 'POST', url: '/api/v1/commands/execute', headers, payload: payload('request-proof-once') });
    expect(first.statusCode).toBe(200);
    const replay = await app.inject({ method: 'POST', url: '/api/v1/commands/execute', headers, payload: payload('request-proof-replay') });
    expect(replay.statusCode).toBe(403);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('redacts secret flags from streamed output and returned errors and applies host manifest context and quotas', async () => {
    await setup();
    const secret = 'journey-runtime-secret-7762';
    execute.mockImplementation(async (request: { descriptor: { configSection?: string }; timeoutMs: number; context?: { sensitiveValues?: string[] } }, options: { onLog: (entry: { stream: 'stderr'; message: string }) => void }) => {
      options.onLog({ stream: 'stderr', message: `plugin echoed ${secret}` });
      expect(request.descriptor.configSection).toBe('commit');
      expect(request.timeoutMs).toBe(1500);
      expect(request.context).toMatchObject({ sensitiveValues: [secret] });
      return { ok: false, error: { envelope: { code: 'KB_PLUGIN_COMMAND_FAILED', message: `failed with ${secret}`, hint: `remove ${secret}` } } };
    });
    const response = await app.inject({
      method: 'POST', url: '/api/v1/commands/execute', headers: trustedHeaders(),
      payload: { requestId: 'request-secret', pluginId: '@kb-labs/fixture', commandPath: 'commit preview', timeoutMs: 4000, input: { argv: [], flags: { secret } } },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(secret);
    const events = response.body.trim().split('\n').map((line: string) => JSON.parse(line));
    expect(events).toContainEqual(expect.objectContaining({ type: 'execution:output', data: expect.stringContaining('[REDACTED]') }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'execution:error', error: expect.objectContaining({ message: expect.stringContaining('[REDACTED]') }) }));
  });

  // case: S-160.1
  it('does not copy the runtime guard credential into the plugin execution environment', async () => {
    const previous = process.env[PROJECT_RUNTIME_TOKEN_ENV];
    process.env[PROJECT_RUNTIME_TOKEN_ENV] = runtimeToken;
    try {
      await setup();
      const response = await app.inject({
        method: 'POST', url: '/api/v1/commands/execute', headers: trustedHeaders(),
        payload: { requestId: 'request-env-isolation', pluginId: '@kb-labs/fixture', commandPath: 'commit preview', input: { argv: [], flags: {} } },
      });
      expect(response.statusCode).toBe(200);
      expect(execute.mock.calls[0]?.[0].env).not.toHaveProperty(PROJECT_RUNTIME_TOKEN_ENV);
    } finally {
      if (previous === undefined) { delete process.env[PROJECT_RUNTIME_TOKEN_ENV]; }
      else { process.env[PROJECT_RUNTIME_TOKEN_ENV] = previous; }
    }
  });

  // case: S-203.26
  it('rejects duplicate kebab and camel spellings of a secret flag before execution', async () => {
    await setup();
    const selectedManifest = { ...manifest, cli: { commands: [{ ...manifest.cli!.commands[0]!, flags: [{ name: 'access-token', type: 'string' as const, secret: true }] }] } };
    registry = { snapshot: () => ({ partial: false, stale: false, manifests: [{ pluginId: '@kb-labs/fixture', manifest: selectedManifest, pluginRoot }] }) } as unknown as IEntityRegistry;
    await app.close();
    app = Fastify();
    await registerProjectCommandExecutionRoute(app, { registry, projectId: 'prj_fixture', projectRoot: pluginRoot, platformRoot: pluginRoot, runtimeToken });
    await app.ready();
    const response = await app.inject({
      method: 'POST', url: '/api/v1/commands/execute', headers: trustedHeaders(),
      payload: { requestId: 'request-duplicate-secret', pluginId: '@kb-labs/fixture', commandPath: 'commit preview', input: { argv: [], flags: { 'access-token': 'first-secret', accessToken: 'second-secret' } } },
    });
    expect(response.statusCode).toBe(400);
    expect(execute).not.toHaveBeenCalled();
    expect(response.body).not.toContain('first-secret');
    expect(response.body).not.toContain('second-secret');
  });

  it('rejects client-selected handler, environment, permissions, and unbounded arguments before execution', async () => {
    await setup();
    const base = { pluginId: '@kb-labs/fixture', commandPath: 'commit preview', input: { argv: [], flags: {} } };
    for (const payload of [
      { ...base, handlerRef: '/tmp/untrusted.js' },
      { ...base, env: { SECRET: 'value' } },
      { ...base, permissions: { fs: { write: ['**'] } } },
      { ...base, input: { argv: ['x'.repeat(8193)], flags: {} } },
    ]) {
      const response = await app.inject({ method: 'POST', url: '/api/v1/commands/execute', headers: trustedHeaders(), payload: { requestId: 'request-invalid', ...payload } });
      expect(response.statusCode).toBe(400);
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects a handler symlink that escapes the canonical package root', async () => {
    await setup('./commands/escape.js');
    const outside = path.join(os.tmpdir(), `outside-${Date.now()}.js`);
    roots.push(outside);
    await writeFile(outside, 'export default {}');
    await symlink(outside, path.join(pluginRoot, 'dist', 'commands', 'escape.js'));
    const response = await app.inject({
      method: 'POST', url: '/api/v1/commands/execute',
      headers: trustedHeaders(),
      payload: { requestId: 'request-symlink', pluginId: '@kb-labs/fixture', commandPath: 'commit preview', input: { argv: [], flags: {} } },
    });
    expect(response.statusCode).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  // case: S-030.3
  it('aborts host backend execution when the project request stream disconnects', async () => {
    await setup();
    let backendAborted = false;
    let resolveAbort: (() => void) | undefined;
    const aborted = new Promise<void>((resolve) => { resolveAbort = resolve; });
    execute.mockImplementation((_request: unknown, options: { signal: AbortSignal }) => new Promise((resolve) => {
      options.signal.addEventListener('abort', () => {
        backendAborted = true;
        resolveAbort?.();
        resolve({ ok: false, error: { envelope: { code: 'KB_RUNTIME_UNEXPECTED' } } });
      }, { once: true });
    }));
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const controller = new AbortController();
    const response = await fetch(`${address}/api/v1/commands/execute`, {
      method: 'POST', signal: controller.signal,
      headers: { 'content-type': 'application/json', ...trustedHeaders() },
      body: JSON.stringify({ requestId: 'request-cancel', pluginId: '@kb-labs/fixture', commandPath: 'commit preview', input: { argv: [], flags: {} } }),
    });
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    await Promise.race([aborted, delay(1500).then(() => { throw new Error('backend signal was not aborted'); })]);
    expect(backendAborted).toBe(true);
  });

  it('rejects a request forwarded for another project', async () => {
    await setup();
    const response = await app.inject({ method: 'POST', url: '/api/v1/commands/execute', headers: trustedHeaders('prj_other'), payload: { requestId: 'request-other', pluginId: '@kb-labs/fixture', commandPath: 'commit preview', input: { argv: [], flags: {} } } });
    expect(response.statusCode).toBe(403);
    expect(execute).not.toHaveBeenCalled();
  });
});
