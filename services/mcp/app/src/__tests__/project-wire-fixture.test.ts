import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoOpLogger } from '@kb-labs/core-platform/noop';
import { createErrorEnvelope, PLATFORM_AUDIT_COLLECTION } from '@kb-labs/core-platform';
import type { IServiceTransport } from '@kb-labs/core-platform';
import { createInMemoryDocumentDatabase, InMemoryCache } from '@kb-labs/core-platform/inmemory';
import { openCatalog } from '@kb-labs/core-registry';
import type { BaseDocument } from '@kb-labs/core-platform/adapters';
import { forwardedIdentityHeaders } from '@kb-labs/gateway-contracts';
import type { ServiceManifest } from '@kb-labs/plugin-contracts';
import { workflowServiceOperations } from '@kb-labs/workflow-runtime';
import type { PlatformContainer } from '@kb-labs/core-runtime';
import type { Policy } from '@kb-labs/core-policy';
import { McpDaemonServer } from '../server.js';
import { callOutput } from '../mcp/output-capture.js';

const executeCommandV3 = vi.hoisted(() => vi.fn());
vi.mock('@kb-labs/cli-runtime', () => ({
  executeCommandV3: (...args: unknown[]) => executeCommandV3(...args),
}));

interface WireResponse {
  step: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}

const fixturePath = resolve(
  fileURLToPath(new URL('../../../../../e2e/journey/fixtures/project-mcp-responses.json', import.meta.url)),
);

async function postMcp(port: number, id: number, method: string, params: unknown,
  identity?: Record<string, string>): Promise<Omit<WireResponse, 'step'>> {
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/mcp`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...identity,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  return {
    status: response.status,
    headers: { 'content-type': response.headers.get('content-type') ?? '' },
    body: await response.text(),
  };
}

interface McpWirePayload {
  result?: {
    isError?: boolean;
    structuredContent?: unknown;
    tools?: Array<{
      name: string;
      inputSchema: { properties: Record<string, { type: string }>; required?: string[] };
    }>;
  };
}

function parseMcpResponse(body: string): McpWirePayload {
  const eventData = body.split(/\r?\n/).filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim()).filter(Boolean).at(-1);
  return JSON.parse(eventData ?? body) as McpWirePayload;
}

describe('project MCP wire fixture producer', () => {
  let daemon: McpDaemonServer | undefined;
  let catalog: Awaited<ReturnType<typeof openCatalog>> | undefined;
  let projectRoot: string | undefined;

  afterEach(async () => {
    const runningDaemon = daemon;
    const resolvedCatalog = catalog;
    const temporaryProjectRoot = projectRoot;
    daemon = undefined;
    catalog = undefined;
    projectRoot = undefined;
    try {
      await runningDaemon?.stop();
    } finally {
      await resolvedCatalog?.dispose();
      vi.unstubAllEnvs();
      if (temporaryProjectRoot) {await rm(temporaryProjectRoot, { recursive: true, force: true });}
    }
  });

  it('records responses emitted by the real project MCP server and detects protocol drift', async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'kb-mcp-wire-'));
    const pluginRoot = join(projectRoot, 'plugins', 'wire-fixture');
    await mkdir(join(pluginRoot, 'dist'), { recursive: true });
    await writeFile(join(projectRoot, 'pnpm-workspace.yaml'), 'packages:\n  - "plugins/*"\n');
    await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({
      name: '@fixture/wire-plugin',
      version: '1.0.0',
      kb: { manifest: './dist/manifest.js' },
    }));
    await writeFile(join(pluginRoot, 'dist', 'manifest.json'), JSON.stringify({
      schema: 'kb.plugin/3',
      id: '@fixture/wire-plugin',
      version: '1.0.0',
      cli: { commands: [{
        path: 'echo',
        describe: 'Return fixture adapter output',
        handler: 'dist/commands/echo.js',
        operationType: 'read',
        flags: [{ name: 'text', type: 'string', required: true }],
      }] },
    }));
    executeCommandV3.mockReset();
    executeCommandV3.mockImplementation(async () => {
      callOutput.getStore()?.text.push('output from the external command adapter');
      return 0;
    });
    catalog = await openCatalog({ platformRoot: projectRoot, projectRoot }, { resolvePlatformVersion: async () => 'test' });
    daemon = new McpDaemonServer({
      port: 0,
      host: '127.0.0.1',
      logger: new NoOpLogger(),
      cache: new InMemoryCache(),
      catalog,
      platform: {
        analytics: { track: async () => undefined },
        documentDatabase: createInMemoryDocumentDatabase(),
      } as unknown as PlatformContainer,
      projectRoot,
      policy: { schemaVersion: '1.0', default: 'allow', rules: [] } satisfies Policy,
      authMode: 'local',
    });
    const address = await daemon.start();
    const port = Number(new URL(address).port);

    const responses: WireResponse[] = [
      { ...(await postMcp(port, 1, 'initialize', {
        protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fixture-client', version: '1' },
      })), step: 'initialize' },
      { ...(await postMcp(port, 2, 'tools/list', {})), step: 'tools/list' },
      { ...(await postMcp(port, 3, 'tools/call', {
        name: 'fixture-wire-plugin__echo', arguments: { text: 'through real router' },
      })), step: 'tool call' },
      { ...(await postMcp(port, 4, 'unknown/method', {})), step: 'error' },
    ];

    const generated = `${JSON.stringify(responses, null, 2)}\n`;
    if (process.env.KB_UPDATE_PROJECT_MCP_FIXTURE === '1') {
      await mkdir(dirname(fixturePath), { recursive: true });
      await writeFile(fixturePath, generated, 'utf8');
    }
    await expect(readFile(fixturePath, 'utf8')).resolves.toBe(generated);
    expect(executeCommandV3).toHaveBeenCalledWith(expect.objectContaining({
      pluginId: '@fixture/wire-plugin',
      commandPath: 'fixture-wire-plugin__echo',
      flags: { text: 'through real router' },
    }));
  });

  // case: S-045.12
  it('exposes service route placeholders as required MCP inputs and dispatches cron enable/disable', async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'kb-mcp-service-route-'));
    catalog = await openCatalog({ platformRoot: projectRoot, projectRoot }, { resolvePlatformVersion: async () => 'test' });
    const cronState = new Map([['journey-cron', false]]);
    const serviceCall = vi.fn<IServiceTransport['call']>().mockImplementation(async (_serviceId, request) => {
      const path = request.path.split('?')[0] ?? request.path;
      const enabled = path.endsWith('/enable');
      cronState.set('journey-cron', enabled);
      return {
        ok: true,
        statusCode: 200,
        payload: { ok: true, data: { enabled: cronState.get('journey-cron') } },
      };
    });
    const serviceTransport = { call: serviceCall } as unknown as IServiceTransport;
    const workflowManifest: ServiceManifest = {
      schema: 'kb.service/1',
      id: 'workflow',
      name: 'Workflow',
      version: '1.0.0',
      description: 'Workflow daemon test manifest',
      runtime: { entry: 'dist/index.js', port: 7777, healthCheck: '/health' },
      projectApi: { serviceId: 'workflow', rewritePrefix: '/api/v1' },
      commands: ['enable', 'disable'].map((action) => ({
        kind: 'service' as const,
        name: `workflow crons ${action}`,
        description: `${action} a workflow cron`,
        scope: 'project' as const,
        category: 'workflow',
        jsonTest: {},
        flags: { json: { type: 'boolean' as const } },
        invocation: {
          operationId: 'workflow.cron.set-enabled',
          inputs: [{ name: 'id', type: 'string' as const, required: true, source: { kind: 'positional' as const, index: 0 } }],
          values: { enabled: action === 'enable' },
        },
        route: { method: 'POST' as const, path: `/crons/{id}/${action}`, mount: 'project-api' as const },
      })),
    };

    daemon = new McpDaemonServer({
      port: 0,
      host: '127.0.0.1',
      logger: new NoOpLogger(),
      cache: new InMemoryCache(),
      catalog,
      platform: {
        analytics: { track: async () => undefined },
        documentDatabase: createInMemoryDocumentDatabase(),
      } as unknown as PlatformContainer,
      projectRoot,
      policy: { schemaVersion: '1.0', default: 'allow', rules: [] } satisfies Policy,
      authMode: 'local',
      gatewayUrl: 'https://gateway.test',
      serviceManifests: [workflowManifest],
      serviceTransport,
      serviceOperations: workflowServiceOperations,
    });
    const address = await daemon.start();
    const port = Number(new URL(address).port);

    const listed = await postMcp(port, 1, 'tools/list', {});
    expect(listed.status).toBe(200);
    const listResult = parseMcpResponse(listed.body).result;
    if (!listResult?.tools) {throw new Error('MCP tools/list returned no tool catalog.');}
    const tools = listResult.tools;
    const enableTool = tools.find((tool) => tool.name === 'workflow__workflow_crons_enable');
    const disableTool = tools.find((tool) => tool.name === 'workflow__workflow_crons_disable');
    expect(enableTool?.inputSchema).toMatchObject({ properties: { id: { type: 'string', minLength: 1 } }, required: ['id'], additionalProperties: false });
    expect(disableTool?.inputSchema).toMatchObject({ properties: { id: { type: 'string', minLength: 1 } }, required: ['id'], additionalProperties: false });

    const missingId = await postMcp(port, 2, 'tools/call', {
      name: 'workflow__workflow_crons_enable', arguments: {},
    });
    const missingResult = parseMcpResponse(missingId.body).result;
    if (!missingResult) {throw new Error('MCP tools/call returned no result for a missing argument.');}
    expect(missingResult.isError).toBe(true);
    expect(missingResult.structuredContent).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_INPUT_INVALID' } });
    expect(serviceCall).not.toHaveBeenCalled();

    const emptyId = await postMcp(port, 5, 'tools/call', {
      name: 'workflow__workflow_crons_enable', arguments: { id: '' },
    });
    expect(parseMcpResponse(emptyId.body).result?.structuredContent).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_INPUT_INVALID' } });
    expect(serviceCall).not.toHaveBeenCalled();

    const presentationFlag = await postMcp(port, 6, 'tools/call', {
      name: 'workflow__workflow_crons_enable', arguments: { id: 'journey-cron', json: true },
    });
    expect(parseMcpResponse(presentationFlag.body).result?.structuredContent).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_INPUT_INVALID' } });
    expect(serviceCall).not.toHaveBeenCalled();

    const enabled = await postMcp(port, 3, 'tools/call', {
      name: 'workflow__workflow_crons_enable', arguments: { id: 'journey-cron' },
    });
    const enableResult = parseMcpResponse(enabled.body).result;
    if (!enableResult) {throw new Error('MCP tools/call returned no result for cron enable.');}
    expect(enableResult.isError).toBe(false);
    expect(enableResult.structuredContent).toMatchObject({ ok: true, data: { id: 'journey-cron', enabled: true } });
    const disabled = await postMcp(port, 4, 'tools/call', {
      name: 'workflow__workflow_crons_disable', arguments: { id: 'journey-cron' },
    });
    const disableResult = parseMcpResponse(disabled.body).result;
    if (!disableResult) {throw new Error('MCP tools/call returned no result for cron disable.');}
    expect(disableResult.isError).toBe(false);
    expect(disableResult.structuredContent).toMatchObject({ ok: true, data: { id: 'journey-cron', enabled: false } });
    expect(cronState.get('journey-cron')).toBe(false);
    serviceCall.mockResolvedValueOnce({
      ok: false,
      statusCode: 403,
      payload: { ok: false, error: createErrorEnvelope('KB_RUNTIME_COMMAND_FAILED', {
        message: 'Cron operation failed.', hint: 'Retry the operation.',
        details: { command: 'workflow cron toggle' }, correlationId: 'fixture-correlation',
      }) },
    });
    const rejected = await postMcp(port, 7, 'tools/call', {
      name: 'workflow__workflow_crons_enable', arguments: { id: 'journey-cron' },
    });
    expect(parseMcpResponse(rejected.body).result).toMatchObject({
      isError: true,
      structuredContent: { ok: false, error: {
        code: 'KB_RUNTIME_COMMAND_FAILED', message: 'Cron operation failed.',
        hint: 'Retry the operation.', details: { command: 'workflow cron toggle' }, correlationId: 'fixture-correlation',
      } },
    });
    serviceCall.mockResolvedValueOnce({ ok: false, statusCode: 502, payload: { error: 'not a UX result' } });
    const malformedServiceResponse = await postMcp(port, 8, 'tools/call', {
      name: 'workflow__workflow_crons_disable', arguments: { id: 'journey-cron' },
    });
    const fallbackError = parseMcpResponse(malformedServiceResponse.body).result?.structuredContent;
    const actualMcpError = (fallbackError as { error: Record<string, unknown> }).error;
    const normalizedMcpError = { ...actualMcpError, correlationId: '<dynamic>' };
    expect(normalizedMcpError).toEqual(createErrorEnvelope('KB_RUNTIME_GATEWAY_PROTOCOL_FAILURE', {
      details: { httpStatus: '502', requestStage: 'Gateway request', gatewayUrl: 'https://gateway.test' },
      correlationId: '<dynamic>',
    }));
    expect(serviceCall.mock.calls.map(([serviceId, request]) => [serviceId, request.path])).toEqual([
      ['workflow', '/api/v1/crons/journey-cron/enable'],
      ['workflow', '/api/v1/crons/journey-cron/disable'],
      ['workflow', '/api/v1/crons/journey-cron/enable'],
      ['workflow', '/api/v1/crons/journey-cron/disable'],
    ]);
  });

  // case: S-253.3, S-045.10
  it('audits secured tool outcomes with forwarded identity while analytics stays separate', async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'kb-mcp-audit-'));
    const pluginRoot = join(projectRoot, 'plugins', 'audit-fixture');
    await mkdir(join(pluginRoot, 'dist'), { recursive: true });
    await writeFile(join(projectRoot, 'pnpm-workspace.yaml'), 'packages:\n  - "plugins/*"\n');
    await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({
      name: '@fixture/audit-plugin', version: '1.0.0', kb: { manifest: './dist/manifest.js' },
    }));
    await writeFile(join(pluginRoot, 'dist', 'manifest.json'), JSON.stringify({
      schema: 'kb.plugin/3', id: '@fixture/audit-plugin', version: '1.0.0',
      cli: { commands: [{
        path: 'mutate', describe: 'Mutate fixture state', handler: 'dist/commands/mutate.js',
        operationType: 'write', flags: [{ name: 'value', type: 'string', required: true }],
      }] },
    }));

    const docs = createInMemoryDocumentDatabase();
    const track = vi.fn(async () => undefined);
    const secret = 'audit-channel-secret';
    vi.stubEnv('GATEWAY_INTERNAL_SECRET', secret);
    executeCommandV3.mockReset();
    executeCommandV3.mockImplementation(async () => {
      callOutput.getStore()?.text.push('mutation complete');
      return 0;
    });
    catalog = await openCatalog({ platformRoot: projectRoot, projectRoot }, { resolvePlatformVersion: async () => 'test' });
    daemon = new McpDaemonServer({
      port: 0, host: '127.0.0.1', logger: new NoOpLogger(), cache: new InMemoryCache(), catalog,
      platform: {
        analytics: { track }, documentDatabase: docs,
      } as unknown as PlatformContainer,
      projectRoot,
      gatewayUrl: 'https://gateway.example.test',
      policy: { schemaVersion: '1.0', default: 'allow', rules: [] } satisfies Policy,
      authMode: 'secured',
    });
    const address = await daemon.start();
    const port = Number(new URL(address).port);
    const identity = forwardedIdentityHeaders({
      type: 'user', userId: 'user-audit-1', tokenId: 'token-audit-1',
      namespaceId: 'project-a', tier: 'free', permissions: [],
    }, secret);
    const noTokenIdentity = forwardedIdentityHeaders({
      type: 'user', userId: 'user-audit-1',
      namespaceId: 'project-a', tier: 'free', permissions: [],
    }, secret);
    const opaqueHostIdentity = forwardedIdentityHeaders({
      type: 'machine', userId: 'host-agent-1', namespaceId: 'project-a', tier: 'free', permissions: ['host:connect'],
    }, secret);

    const rejected = await postMcp(port, 0, 'tools/call', {
      name: 'fixture-audit-plugin__mutate', arguments: { value: 'must not run' },
    }, noTokenIdentity);
    expect(rejected.status).toBe(401);
    expect(executeCommandV3).not.toHaveBeenCalled();

    const opaqueRejected = await postMcp(port, 4, 'tools/list', {}, opaqueHostIdentity);
    expect(opaqueRejected.status).toBe(401);
    expect(JSON.parse(opaqueRejected.body)).toMatchObject({
      ok: false,
      error: {
        ...createErrorEnvelope('KB_AUTH_MCP_CREDENTIAL_REQUIRED', { details: { gatewayUrl: 'https://gateway.example.test' } }),
        correlationId: expect.any(String),
      },
    });
    expect(executeCommandV3).not.toHaveBeenCalled();

    const success = await postMcp(port, 1, 'tools/call', {
      name: 'fixture-audit-plugin__mutate', arguments: { value: 'private argument' },
    }, identity);
    expect(success.status, success.body).toBe(200);
    const error = await postMcp(port, 2, 'tools/call', {
      name: 'missing-tool', arguments: { secret: 'private secret' },
    }, identity);
    expect(error.status).toBe(200);

    const records = await docs.find<BaseDocument & Record<string, unknown>>(PLATFORM_AUDIT_COLLECTION, {});
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      kind: 'mcp.tool.call', actorUserId: 'user-audit-1', tokenId: 'token-audit-1',
      project: projectRoot, tool: 'fixture-audit-plugin__mutate', outcome: 'success',
    });
    expect(records[0]).toHaveProperty('correlationId');
    expect(records[0]).toHaveProperty('occurredAt');
    expect(JSON.stringify(records)).not.toContain('private argument');
    expect(JSON.stringify(records)).not.toContain('private secret');
    expect(records[1]).toMatchObject({
      kind: 'mcp.tool.call', actorUserId: 'user-audit-1', tokenId: 'token-audit-1',
      tool: 'missing-tool', outcome: 'KB_RUNTIME_MCP_UNKNOWN_TOOL',
    });
    expect(track).toHaveBeenCalledWith('mcp.tool.call.completed', expect.objectContaining({
      toolName: 'fixture-audit-plugin__mutate', success: true,
    }));
    expect(records.every((record) => record.kind !== 'analytics')).toBe(true);
  });
});
