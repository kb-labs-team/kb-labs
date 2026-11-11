import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ICache, ILogger, IServiceTransport } from '@kb-labs/core-platform';
import type * as CoreRuntimeModule from '@kb-labs/core-runtime';
import type { ManifestV3, PluginContextV3 } from '@kb-labs/plugin-contracts';
import { noopTraceContext, noopUI } from '@kb-labs/plugin-contracts';
import { createInMemoryDocumentDatabase } from '@kb-labs/sdk/testing';
import { InMemoryCache } from '@kb-labs/core-platform/inmemory';
import { createErrorEnvelope, ErrorEnvelopeError } from '@kb-labs/core-platform/error-envelope';
import { WebhookSecretStore } from '../webhook/secret-store.js';

const { mockAdapters, mockBroker, mockDispatcher } = vi.hoisted(() => {
  const adapters: Record<string, unknown> = {};
  const broker = {
    registerLimit: vi.fn(),
    tryAcquire: vi.fn(async () => ({ allowed: true, release: async () => undefined })),
  };
  const dispatcher = { firstHostWithCapability: vi.fn(), call: vi.fn() };
  return { mockAdapters: adapters, mockBroker: broker, mockDispatcher: dispatcher };
});

vi.mock('@kb-labs/core-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof CoreRuntimeModule>();
  return {
    ...actual,
    platform: {
      ...actual.platform,
      getAdapter: (name: string) => mockAdapters[name],
      get hasResourceBroker() { return true; },
      get documentDatabase() { return mockAdapters.documentDatabase; },
      get resourceBroker() { return mockBroker; },
    },
  };
});
vi.mock('../hosts/dispatcher.js', () => ({ globalDispatcher: mockDispatcher, HostCallDispatcher: vi.fn() }));

import { createServer } from '../server.js';

const pluginId = 'history-fixture';
const event = 'alert';
const namespaceId = 'local';
const secret = 'history-test-secret';
const body = JSON.stringify({ message: 'safe test payload' });
const manifest: ManifestV3 = {
  schema: 'kb.plugin/3',
  id: pluginId,
  version: '1.0.0',
  webhooks: {
    handlers: [{
      event,
      handler: './dist/webhooks/alert.js#default',
      auth: { type: 'hmac', header: 'x-signature', prefix: 'sha256=' },
    }],
  },
};

const logger: ILogger = {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  child: vi.fn(function () { return logger; }),
} as unknown as ILogger;
const transport: IServiceTransport = {
  connectionInfo: () => undefined,
  call: async () => ({ ok: true, statusCode: 200, payload: null }),
  stream: async () => { throw new Error('not used'); },
} as unknown as IServiceTransport;

function signed(bodyText: string): string {
  return `sha256=${createHmac('sha256', secret).update(bodyText).digest('hex')}`;
}

type CliOutput = { output: string[]; errors: string[]; json: unknown[] };

function commandContext(captured: CliOutput, cwd: string): PluginContextV3 {
  return {
    host: 'cli', requestId: 'live-history-test', pluginId: '@kb-labs/system', pluginVersion: '1.0.0', cwd,
    ui: {
      ...noopUI,
      write: (value: string) => captured.output.push(value),
      error: (value: string) => captured.errors.push(value),
      json: (value: unknown) => captured.json.push(value),
    },
    platform: {} as unknown as PluginContextV3['platform'],
    runtime: {} as unknown as PluginContextV3['runtime'],
    api: {} as PluginContextV3['api'],
    hostContext: { host: 'cli', binaryName: 'kb', argv: [], flags: {} },
    trace: noopTraceContext,
  };
}

async function makeApp() {
  const documents = createInMemoryDocumentDatabase();
  mockAdapters.documentDatabase = documents;
  const cache = new InMemoryCache();
  await new WebhookSecretStore(cache).set(namespaceId, pluginId, event, { current: secret });
  mockDispatcher.firstHostWithCapability.mockReturnValue('execution-host');
  mockDispatcher.call.mockResolvedValue({ handled: true });
  const app = await createServer(
    { port: 0, access: { mode: 'local' }, upstreams: {}, staticTokens: {} },
    cache as unknown as ICache,
    logger,
    { secret: 'test-secret-that-is-long-enough' },
    undefined,
    transport,
    undefined,
    [{ pluginId, manifest, pluginRoot: '/plugins/history-fixture' }],
  );
  await app.ready();
  return { app, documents, cache };
}

afterEach(() => {
  vi.clearAllMocks();
  delete mockAdapters.documentDatabase;
});

describe('Gateway webhook history through createServer', () => {
  // case: S-250.2
  it('records delivered and catalogued handler-error outcomes readable over REST', async () => {
    const { app, documents } = await makeApp();
    try {
      const success = await app.inject({
        method: 'POST', url: `/webhooks/${pluginId}/${event}`,
        headers: { 'x-kb-namespace': namespaceId, 'x-signature': signed(body), 'x-request-id': 'success-correlation', 'content-type': 'application/json' },
        payload: body,
      });
      expect(success.statusCode).toBe(200);
      const successId = success.json().data.webhookId as string;
      const successHistory = await app.inject({ method: 'GET', url: `/api/v1/webhooks/history/${successId}` });
      expect(successHistory.statusCode, JSON.stringify(successHistory.json())).toBe(200);
      expect(successHistory.json().data.record).toMatchObject({
        webhookId: successId, project: namespaceId, pluginId,
        handler: './dist/webhooks/alert.js#default', outcome: { type: 'delivered' },
        correlationId: 'success-correlation',
      });
      expect(JSON.stringify(successHistory.json())).not.toContain('safe test payload');
      expect(JSON.stringify(successHistory.json())).not.toContain(secret);

      const error = new ErrorEnvelopeError(createErrorEnvelope('KB_PLUGIN_COMMAND_FAILED', {
        details: { plugin: 'test-plugin', command: 'test command', failureReason: 'test failure' },
      }));
      mockDispatcher.call.mockRejectedValueOnce(error);
      const failed = await app.inject({
        method: 'POST', url: `/webhooks/${pluginId}/${event}`,
        headers: { 'x-kb-namespace': namespaceId, 'x-signature': signed(body), 'x-request-id': 'error-correlation', 'content-type': 'application/json' },
        payload: body,
      });
      expect(failed.statusCode).toBe(500);
      const errorId = failed.headers['x-webhook-id'] as string;
      const errorHistory = await app.inject({ method: 'GET', url: `/api/v1/webhooks/history/${errorId}` });
      expect(errorHistory.statusCode, JSON.stringify(errorHistory.json())).toBe(200);
      expect(errorHistory.json().data.record).toMatchObject({
        webhookId: errorId, outcome: { type: 'handler_error', code: 'KB_PLUGIN_COMMAND_FAILED' },
        correlationId: 'error-correlation',
      });
      expect(await documents.count('gateway_webhook_history', {})).toBe(2);
    } finally {
      await app.close();
    }
  });

  // case: S-250.2
  it('reads the same live records through REST and the real CLI command in JSON and human modes', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'kb-webhook-cli-history-'));
    const previousHome = process.env.HOME;
    const previousGatewayUrl = process.env.KB_GATEWAY_URL;
    const previousGatewayPort = process.env.GATEWAY_PORT;
    process.env.HOME = home;
    let app: Awaited<ReturnType<typeof createServer>> | undefined;
    try {
      const documents = createInMemoryDocumentDatabase();
      mockAdapters.documentDatabase = documents;
      const cache = new InMemoryCache();
      await new WebhookSecretStore(cache).set(namespaceId, pluginId, event, { current: secret });
      mockDispatcher.firstHostWithCapability.mockReturnValue('execution-host');
      mockDispatcher.call.mockResolvedValue({ handled: true });
      app = await createServer(
        { port: 0, access: { mode: 'local' }, upstreams: {}, staticTokens: {} },
        cache as unknown as ICache,
        logger,
        { secret: 'test-secret-that-is-long-enough' },
        undefined,
        transport,
        undefined,
        [{ pluginId, manifest, pluginRoot: '/plugins/history-fixture' }],
      );
      await app.listen({ port: 0, host: '127.0.0.1' });
      const address = app.server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Gateway did not bind an ephemeral TCP port');
      }
      process.env.KB_GATEWAY_URL = `http://127.0.0.1:${address.port}`;
      process.env.GATEWAY_PORT = String(address.port);

      const deliver = async (correlationId: string) => fetch(`${process.env.KB_GATEWAY_URL}/webhooks/${pluginId}/${event}`, {
        method: 'POST',
        headers: {
          'x-kb-namespace': namespaceId,
          'x-signature': signed(body),
          'x-request-id': correlationId,
          'content-type': 'application/json',
        },
        body,
      });
      const delivered = await deliver('live-success-correlation');
      expect(delivered.status).toBe(200);
      const deliveredId = delivered.headers.get('x-webhook-id');
      expect(deliveredId).toBeTruthy();

      mockDispatcher.call.mockRejectedValueOnce(new ErrorEnvelopeError(createErrorEnvelope('KB_PLUGIN_COMMAND_FAILED', {
        details: { plugin: 'test-plugin', command: 'test command', failureReason: 'test failure' },
      })));
      const errored = await deliver('live-error-correlation');
      expect(errored.status).toBe(500);
      const erroredId = errored.headers.get('x-webhook-id');
      expect(erroredId).toBeTruthy();

      const restRecords = new Map<string, Record<string, unknown>>();
      for (const webhookId of [deliveredId!, erroredId!]) {
        const response = await fetch(`${process.env.KB_GATEWAY_URL}/api/v1/webhooks/history/${webhookId}`);
        expect(response.status).toBe(200);
        const envelope = await response.json() as { data: { record: Record<string, unknown> } };
        restRecords.set(webhookId, envelope.data.record);
      }

      const cliModuleUrl = new URL('../../../../../cli/commands/src/commands/system/webhook/webhook-history.ts', import.meta.url).href;
      const { webhookHistory } = await import(cliModuleUrl);
      for (const webhookId of [deliveredId!, erroredId!]) {
        const captured: CliOutput = { output: [], errors: [], json: [] };
        const exitCode = await webhookHistory.run(commandContext(captured, home), [webhookId], { json: true });
        expect(exitCode, JSON.stringify({ errors: captured.errors, json: captured.json })).toBe(0);
        expect(captured.json[0]).toMatchObject({ ok: true, data: { record: restRecords.get(webhookId) } });
        expect(JSON.stringify(captured.json)).not.toContain('safe test payload');
        expect(JSON.stringify(captured.json)).not.toContain(secret);
      }

      for (const webhookId of [deliveredId!, erroredId!]) {
        const captured: CliOutput = { output: [], errors: [], json: [] };
        const exitCode = await webhookHistory.run(commandContext(captured, home), [webhookId], {});
        const record = restRecords.get(webhookId)!;
        const output = captured.output.join('');
        expect(exitCode, captured.errors.join('')).toBe(0);
        expect(output).toContain(`Webhook: ${record.webhookId}`);
        expect(output).toContain(`Correlation ID: ${record.correlationId}`);
        expect(output.split('\n')).toContain(record.outcome && (record.outcome as { type: string }).type === 'delivered'
          ? 'Outcome: delivered'
          : 'Outcome: handler_error (KB_PLUGIN_COMMAND_FAILED)');
        expect(output).not.toContain('safe test payload');
        expect(output).not.toContain(secret);
      }
    } finally {
      await app?.close();
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousGatewayUrl === undefined) {
        delete process.env.KB_GATEWAY_URL;
      } else {
        process.env.KB_GATEWAY_URL = previousGatewayUrl;
      }
      if (previousGatewayPort === undefined) {
        delete process.env.GATEWAY_PORT;
      } else {
        process.env.GATEWAY_PORT = previousGatewayPort;
      }
      await rm(home, { recursive: true, force: true });
    }
  });

  // case: S-250.3
  it('reads signature rejection history through REST and CLI', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'kb-webhook-signature-history-'));
    const previousHome = process.env.HOME;
    const previousGatewayUrl = process.env.KB_GATEWAY_URL;
    const previousGatewayPort = process.env.GATEWAY_PORT;
    let app: Awaited<ReturnType<typeof createServer>> | undefined;
    try {
      const fixture = await makeApp();
      app = fixture.app;
      await app.listen({ port: 0, host: '127.0.0.1' });
      const address = app.server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Gateway did not bind an ephemeral TCP port');
      }
      process.env.HOME = home;
      process.env.KB_GATEWAY_URL = `http://127.0.0.1:${address.port}`;
      process.env.GATEWAY_PORT = String(address.port);

      const rejected = await fetch(`${process.env.KB_GATEWAY_URL}/webhooks/${pluginId}/${event}`, {
        method: 'POST',
        headers: {
          'x-kb-namespace': namespaceId,
          'x-signature': 'sha256=invalid',
          'x-request-id': 'rejected-correlation',
          'content-type': 'application/json',
        },
        body,
      });
      expect(rejected.status).toBe(401);
      expect(await rejected.json()).toMatchObject({ error: { code: 'KB_AUTH_REQUIRED' } });
      const webhookId = rejected.headers.get('x-webhook-id');
      expect(webhookId).toBeTruthy();
      const history = await fetch(`${process.env.KB_GATEWAY_URL}/api/v1/webhooks/history/${webhookId}`);
      expect(history.status).toBe(200);
      const historyEnvelope = await history.json() as { data: { record: Record<string, unknown> } };
      const record = historyEnvelope.data.record;
      expect(record).toMatchObject({
        webhookId, project: namespaceId, pluginId,
        handler: './dist/webhooks/alert.js#default',
        outcome: { type: 'rejected', code: 'KB_AUTH_REQUIRED' },
        correlationId: 'rejected-correlation',
      });
      expect(mockDispatcher.call).not.toHaveBeenCalled();
      expect(await fixture.documents.count('gateway_webhook_history', {})).toBe(1);
      expect(JSON.stringify(historyEnvelope)).not.toContain(secret);
      expect(JSON.stringify(historyEnvelope)).not.toContain(body);

      const cliModuleUrl = new URL('../../../../../cli/commands/src/commands/system/webhook/webhook-history.ts', import.meta.url).href;
      const { webhookHistory } = await import(cliModuleUrl);
      for (const flags of [{ json: true }, {}]) {
        const captured: CliOutput = { output: [], errors: [], json: [] };
        const exitCode = await webhookHistory.run(commandContext(captured, home), [webhookId!], flags);
        expect(exitCode).toBe(0);
        if (flags.json) {
          expect(captured.json[0]).toMatchObject({ ok: true, data: { record } });
          expect(JSON.stringify(captured.json)).not.toContain(secret);
          expect(JSON.stringify(captured.json)).not.toContain(body);
        } else {
          expect(captured.output.join('')).toContain(`Webhook: ${webhookId}`);
          expect(captured.output.join('')).toContain('Outcome: rejected (KB_AUTH_REQUIRED)');
          expect(captured.output.join('')).toContain('Correlation ID: rejected-correlation');
          expect(captured.output.join('')).not.toContain(secret);
          expect(captured.output.join('')).not.toContain(body);
        }
      }
    } finally {
      await app?.close();
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousGatewayUrl === undefined) {
        delete process.env.KB_GATEWAY_URL;
      } else {
        process.env.KB_GATEWAY_URL = previousGatewayUrl;
      }
      if (previousGatewayPort === undefined) {
        delete process.env.GATEWAY_PORT;
      } else {
        process.env.GATEWAY_PORT = previousGatewayPort;
      }
      await rm(home, { recursive: true, force: true });
    }
  });

  // case: S-250.3
  it('records the normalized oversized-body rejection in REST and CLI history', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'kb-webhook-body-history-'));
    const previousHome = process.env.HOME;
    const previousGatewayUrl = process.env.KB_GATEWAY_URL;
    const previousGatewayPort = process.env.GATEWAY_PORT;
    let app: Awaited<ReturnType<typeof createServer>> | undefined;
    try {
      const fixture = await makeApp();
      app = fixture.app;
      await app.listen({ port: 0, host: '127.0.0.1' });
      const address = app.server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Gateway did not bind an ephemeral TCP port');
      }
      process.env.HOME = home;
      process.env.KB_GATEWAY_URL = `http://127.0.0.1:${address.port}`;
      process.env.GATEWAY_PORT = String(address.port);
      const oversizedBody = JSON.stringify({ value: 'x'.repeat(1_048_576) });
      const rejected = await fetch(`${process.env.KB_GATEWAY_URL}/webhooks/${pluginId}/${event}`, {
        method: 'POST',
        headers: {
          'x-kb-namespace': namespaceId,
          'x-signature': 'sha256=not-relevant',
          'x-request-id': 'large-correlation',
          'content-type': 'application/json',
        },
        body: oversizedBody,
      });
      expect(rejected.status).toBe(413);
      const responseEnvelope = await rejected.json() as {
        ok: boolean;
        error: { code: string; correlationId: string; details: Record<string, unknown> };
      };
      expect(responseEnvelope).toMatchObject({
        ok: false,
        error: {
          code: 'KB_RUNTIME_PAYLOAD_TOO_LARGE',
          correlationId: 'large-correlation',
          details: { limitBytes: '1048576' },
        },
      });
      const webhookId = rejected.headers.get('x-webhook-id');
      expect(webhookId).toBeTruthy();

      const historyResponse = await fetch(`${process.env.KB_GATEWAY_URL}/api/v1/webhooks/history/${webhookId}`);
      expect(historyResponse.status).toBe(200);
      const historyEnvelope = await historyResponse.json() as { data: { record: Record<string, unknown> } };
      const record = historyEnvelope.data.record;
      expect(historyEnvelope.data.record).toMatchObject({ webhookId, outcome: { type: 'rejected', code: responseEnvelope.error.code } });
      expect(record).toMatchObject({
        webhookId,
        project: namespaceId,
        pluginId,
        outcome: { type: 'rejected', code: 'KB_RUNTIME_PAYLOAD_TOO_LARGE' },
        correlationId: 'large-correlation',
      });
      expect(mockDispatcher.call).not.toHaveBeenCalled();
      expect(await fixture.documents.count('gateway_webhook_history', {})).toBe(1);
      expect(JSON.stringify(record)).not.toContain(oversizedBody);
      expect(JSON.stringify(historyEnvelope)).not.toContain(secret);

      const cliModuleUrl = new URL('../../../../../cli/commands/src/commands/system/webhook/webhook-history.ts', import.meta.url).href;
      const { webhookHistory } = await import(cliModuleUrl);
      for (const flags of [{ json: true }, {}]) {
        const captured: CliOutput = { output: [], errors: [], json: [] };
        const exitCode = await webhookHistory.run(commandContext(captured, home), [webhookId!], flags);
        expect(exitCode, JSON.stringify({ errors: captured.errors, json: captured.json })).toBe(0);
        if (flags.json) {
          expect(captured.json[0]).toMatchObject({ ok: true, data: { record } });
          expect(JSON.stringify(captured.json)).not.toContain(oversizedBody);
          expect(JSON.stringify(captured.json)).not.toContain(secret);
        } else {
          expect(captured.output.join('')).toContain(`Webhook: ${webhookId}`);
          expect(captured.output.join('')).toContain('Outcome: rejected (KB_RUNTIME_PAYLOAD_TOO_LARGE)');
          expect(captured.output.join('')).toContain('Correlation ID: large-correlation');
          expect(captured.output.join('')).not.toContain(oversizedBody);
          expect(captured.output.join('')).not.toContain(secret);
        }
      }
    } finally {
      await app?.close();
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousGatewayUrl === undefined) {
        delete process.env.KB_GATEWAY_URL;
      } else {
        process.env.KB_GATEWAY_URL = previousGatewayUrl;
      }
      if (previousGatewayPort === undefined) {
        delete process.env.GATEWAY_PORT;
      } else {
        process.env.GATEWAY_PORT = previousGatewayPort;
      }
      await rm(home, { recursive: true, force: true });
    }
  });
});
