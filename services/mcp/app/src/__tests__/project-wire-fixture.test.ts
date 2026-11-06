import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoOpLogger } from '@kb-labs/core-platform/noop';
import { createErrorEnvelope, PLATFORM_AUDIT_COLLECTION } from '@kb-labs/core-platform';
import { createInMemoryDocumentDatabase, InMemoryCache } from '@kb-labs/core-platform/inmemory';
import { openCatalog } from '@kb-labs/core-registry';
import type { BaseDocument } from '@kb-labs/core-platform/adapters';
import { forwardedIdentityHeaders } from '@kb-labs/gateway-contracts';
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
      if (temporaryProjectRoot) await rm(temporaryProjectRoot, { recursive: true, force: true });
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
