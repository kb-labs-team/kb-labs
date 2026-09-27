import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import type { ExecutionBackend } from '@kb-labs/plugin-execution';
import { mountRoutes } from '@kb-labs/plugin-execution/http';
import type {
  ILLM, ILLMRouter, LLMMessage, LLMOptions, LLMResponse, LLMToolCallOptions,
  LLMToolCallResponse, ManifestV3, PluginContextV3, RestInput, WSMessage, WSSender, WSInput,
} from '@kb-labs/sdk';
import { createTestContext } from '@kb-labs/sdk/testing';
import type { ExecuteSessionPlanRequest, RunRequest } from '@kb-labs/agent-contracts';
import { AGENTS_BASE_PATH, AGENTS_ROUTES, buildRestRoute } from '@kb-labs/agent-contracts';
import { SessionManager } from '@kb-labs/agent-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { manifest as agentManifest } from '../src/manifest.js';
import runHandler from '../src/rest/handlers/run-handler.js';
import approveSessionPlanHandler from '../src/rest/handlers/approve-session-plan-handler.js';
import executeSessionPlanHandler from '../src/rest/handlers/execute-session-plan-handler.js';
import { RunManager } from '../src/rest/run-manager.js';
import sessionStreamHandler from '../src/ws/session-stream-handler.js';
import { isDeepAgentE2EEnabled } from '@kb-labs/shared-testing-e2e';

const tempDirs: string[] = [];

async function createWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agents-http-e2e-'));
  tempDirs.push(dir);
  return dir;
}

function createScriptedLLM(
  scriptedResponses: LLMToolCallResponse | LLMToolCallResponse[] | ((messages: LLMMessage[]) => LLMToolCallResponse),
  completionContent = 'Deterministic scenario completion.',
): ILLM & { requests: LLMMessage[][] } {
  const responses = typeof scriptedResponses === 'function'
    ? []
    : Array.isArray(scriptedResponses) ? [...scriptedResponses] : [scriptedResponses];
  const fallback = responses.at(-1)!;
  const requests: LLMMessage[][] = [];
  return Object.assign({
    complete: vi.fn(async (_prompt: string, _options?: LLMOptions): Promise<LLMResponse> => ({
      content: completionContent,
      model: fallback?.model ?? 'scenario',
      usage: { promptTokens: 2, completionTokens: 2 },
    })),
    stream: async function* () { yield fallback?.content ?? 'Scenario response.'; },
    chatWithTools: vi.fn(async (messages: LLMMessage[], _options: LLMToolCallOptions) => {
      requests.push(messages);
      return typeof scriptedResponses === 'function' ? scriptedResponses(messages) : responses.shift() ?? fallback;
    }),
  }, { requests });
}

function createEventBus() {
  const subscribers = new Map<string, Set<(event: unknown) => Promise<void>>>();
  return {
    async publish<T>(topic: string, event: T): Promise<void> {
      await Promise.all(Array.from(subscribers.get(topic) ?? [], (handler) => handler(event)));
    },
    subscribe<T>(topic: string, handler: (event: T) => Promise<void>): () => void {
      const handlers = subscribers.get(topic) ?? new Set<(event: unknown) => Promise<void>>();
      const wrapped = (event: unknown) => handler(event as T);
      handlers.add(wrapped);
      subscribers.set(topic, handlers);
      return () => handlers.delete(wrapped);
    },
  };
}

function runManifest(paths: string[] = [AGENTS_ROUTES.RUN]): ManifestV3 {
  const routes = agentManifest.rest?.routes.filter((candidate) => paths.includes(candidate.path)) ?? [];
  if (routes.length !== paths.length) throw new Error('An Agents scenario route is missing from the plugin manifest');
  return { ...agentManifest, rest: { ...agentManifest.rest, routes } };
}

function runBackend(ctx: PluginContextV3): ExecutionBackend {
  return {
    async execute(request) {
      const startedAt = Date.now();
      try {
      const input = request.input as RestInput<RunRequest>;
      const data = request.handlerRef.endsWith('approve-session-plan-handler.js')
        ? await approveSessionPlanHandler.execute(ctx, request.input as RestInput<unknown>)
        : request.handlerRef.endsWith('execute-session-plan-handler.js')
          ? await executeSessionPlanHandler.execute(ctx, request.input as RestInput<ExecuteSessionPlanRequest>)
          : await runHandler.execute(ctx, input);
        return { ok: true, data, executionTimeMs: Date.now() - startedAt };
      } catch (error) {
        return {
          ok: false,
          error: { message: error instanceof Error ? error.message : String(error), code: 'VALIDATION_ERROR' },
          executionTimeMs: Date.now() - startedAt,
        };
      }
    },
    async health() { return { healthy: true, backend: 'in-process' }; },
    async stats() { return { totalExecutions: 0, successCount: 0, errorCount: 0, avgExecutionTimeMs: 0 }; },
    async shutdown() {},
  };
}

async function waitForMessage(messages: WSMessage[], predicate: (message: WSMessage) => boolean): Promise<WSMessage> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const message = messages.find(predicate);
    if (message) return message;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for WebSocket run completion');
}

describe('Agents HTTP/WS user scenarios', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it.skipIf(!isDeepAgentE2EEnabled())('starts a REST run and streams the persisted conversation over WS', async () => {
    const workingDir = await createWorkspace();
    const firstTask = 'Запомни кодовое имя Silver Birch.';
    const llm = createScriptedLLM((messages) => ({
      content: JSON.stringify(messages).includes('What code name did I ask you to remember?')
        ? 'Твоё кодовое имя — Silver Birch.'
        : 'Запомнил кодовое имя Silver Birch.',
      model: 'scenario-small', usage: { promptTokens: 6, completionTokens: 7 },
    }));
    const eventBus = createEventBus();
    const { ctx, cleanup } = createTestContext({
      pluginId: '@kb-labs/agents', pluginVersion: 'e2e', host: 'rest', cwd: workingDir,
      platform: { llm, eventBus },
    });
    const messages: WSMessage[] = [];
    const session = await new SessionManager(workingDir).createSession({ mode: 'execute', task: firstTask, agentId: 'e2e-orchestrator' });
    const wsContext = {
      ...ctx,
      host: 'ws',
      hostContext: {
        host: 'ws', channelPath: '/session/:sessionId', connectionId: 'agent-e2e-connection',
        clientIp: '127.0.0.1', headers: {}, params: { sessionId: session.id },
        requestId: 'agent-e2e-request', traceId: 'agent-e2e-trace',
      },
    } satisfies PluginContextV3;
    const sender: WSSender = {
      send: async (message) => { messages.push(message); },
      broadcast: async (message) => { messages.push(message); },
      sendTo: async (_ids, message) => { messages.push(message); },
      close: vi.fn(),
      getConnectionId: () => 'agent-e2e-connection',
    };
    const server = Fastify({ logger: false });
    let activeWsContext = wsContext;

    try {
      await sessionStreamHandler.execute(wsContext, { event: 'connect', sender } satisfies WSInput);
      await mountRoutes(server, runManifest(), {
        backend: runBackend(ctx),
        pluginRoot: path.resolve('plugins/agents/entry'),
        workspaceRoot: workingDir,
        basePath: AGENTS_BASE_PATH,
      });
      const response = await server.inject({
        method: 'POST', url: `${AGENTS_BASE_PATH}${AGENTS_ROUTES.RUN}`,
        payload: { task: firstTask, sessionId: session.id, tier: 'small' } satisfies RunRequest,
      });

      expect(response.statusCode).toBe(200);
      const run = response.json<{ runId: string; sessionId: string; eventsPath: string; status: string }>();
      expect(run).toMatchObject({ sessionId: session.id, status: 'started' });
      expect(run.eventsPath).toContain(session.id);

      const completion = await waitForMessage(messages, (message) => message.type === 'run:completed');
      expect(completion.payload).toMatchObject({ runId: run.runId, success: true });
      expect(messages.some((message) => message.type === 'conversation:snapshot')).toBe(true);
      expect(messages.some((message) => message.type === 'turn:delta')).toBe(true);
      expect(JSON.stringify(completion.payload)).toContain('Silver Birch');

      const followUpResponse = await server.inject({
        method: 'POST', url: `${AGENTS_BASE_PATH}${AGENTS_ROUTES.RUN}`,
        payload: { task: 'What code name did I ask you to remember?', sessionId: session.id, tier: 'small' } satisfies RunRequest,
      });
      expect(followUpResponse.statusCode).toBe(200);
      const followUpRun = followUpResponse.json<{ runId: string }>();
      const followUpCompletion = await waitForMessage(messages, (message) =>
        message.type === 'run:completed' && message.payload.runId === followUpRun.runId,
      );
      expect(followUpCompletion.payload).toMatchObject({ runId: followUpRun.runId, success: true });
      expect(JSON.stringify(followUpCompletion.payload)).toContain('Твоё кодовое имя — Silver Birch.');
      expect(JSON.stringify(llm.requests.at(-1))).toContain(firstTask);

      const turns = await new SessionManager(workingDir).getTurns(session.id);
      expect(turns.some((turn) => turn.type === 'user')).toBe(true);
      expect(turns.some((turn) => turn.type === 'assistant')).toBe(true);

      const snapshotsBeforeReconnect = messages.filter((message) => message.type === 'conversation:snapshot').length;
      await sessionStreamHandler.execute(wsContext, {
        event: 'disconnect', disconnectCode: 1000, disconnectReason: 'simulate page reload',
      });
      const reconnectContext = {
        ...wsContext,
        hostContext: { ...wsContext.hostContext, connectionId: 'agent-e2e-reconnected' },
      } satisfies PluginContextV3;
      const reconnectSender: WSSender = {
        send: async (message) => { messages.push(message); },
        broadcast: async (message) => { messages.push(message); },
        sendTo: async (_ids, message) => { messages.push(message); },
        close: vi.fn(),
        getConnectionId: () => 'agent-e2e-reconnected',
      };
      activeWsContext = reconnectContext;
      await sessionStreamHandler.execute(reconnectContext, { event: 'connect', sender: reconnectSender } satisfies WSInput);
      const refreshedSnapshot = messages.filter((message) => message.type === 'conversation:snapshot').at(-1);
      expect(messages.filter((message) => message.type === 'conversation:snapshot')).toHaveLength(snapshotsBeforeReconnect + 1);
      expect(JSON.stringify(refreshedSnapshot?.payload)).toContain('Твоё кодовое имя — Silver Birch.');
    } finally {
      await sessionStreamHandler.execute(activeWsContext, { event: 'disconnect', disconnectCode: 1000, disconnectReason: 'test complete' });
      await server.close();
      cleanup();
    }
  });

  it.skipIf(!isDeepAgentE2EEnabled())('takes a plan from the Studio request through user approval to visible execution result', async () => {
    const workingDir = await createWorkspace();
    const task = 'Add a tiny scenario marker and verify it';
    const planMarkdown = [
      '# Plan: scenario marker',
      '',
      '## Task',
      task,
      '',
      '## Steps',
      '',
      '### Phase 1: Prepare and verify',
      '- Read `README.md` and identify the scenario workspace.',
      '- Add `scenario-marker.txt` with the requested marker.',
      '',
      '## Risks',
      '- Keep the marker isolated to this test workspace.',
      '',
      '## Verification',
      '- Run `pnpm test` and verify `scenario-marker.txt` contains the marker.',
      '- Confirm no unrelated files changed.',
    ].join('\n');
    const llm = createScriptedLLM([
      {
        content: '', model: 'scenario-plan', usage: { promptTokens: 5, completionTokens: 5 },
        toolCalls: [{ id: 'plan-write', name: 'plan_write', input: { content: planMarkdown } }],
      },
      {
        content: '', model: 'scenario-plan', usage: { promptTokens: 5, completionTokens: 5 },
        toolCalls: [{ id: 'plan-validate', name: 'plan_validate', input: { task, plan_markdown: planMarkdown, tier: 'small' } }],
      },
      {
        content: '', model: 'scenario-plan', usage: { promptTokens: 5, completionTokens: 5 },
        toolCalls: [{ id: 'plan-report', name: 'report', input: { answer: planMarkdown, confidence: 0.95 } }],
      },
      {
        content: '', model: 'scenario-execute', usage: { promptTokens: 5, completionTokens: 5 },
        toolCalls: [{ id: 'write-marker', name: 'fs_write', input: { path: 'scenario-marker.txt', content: 'done by approved plan\n' } }],
      },
      {
        content: '', model: 'scenario-execute', usage: { promptTokens: 5, completionTokens: 5 },
        toolCalls: [{ id: 'execution-report', name: 'report', input: { answer: 'Approved plan executed. `scenario-marker.txt` contains the requested marker.', confidence: 0.95 } }],
      },
    ], [
      'SCORE: 0.95',
      'SPECIFICITY: 0.95',
      'ACTIONABILITY: 0.95',
      'COMPLETENESS: 0.95',
      'VERIFICATION: 0.95',
      'FEEDBACK:',
      'Plan meets quality threshold.',
    ].join('\n'));
    const eventBus = createEventBus();
    const { ctx, cleanup } = createTestContext({
      pluginId: '@kb-labs/agents', pluginVersion: 'e2e', host: 'rest', cwd: workingDir,
      platform: { llm, eventBus },
    });
    const messages: WSMessage[] = [];
    const session = await new SessionManager(workingDir).createSession({ mode: 'plan', task, agentId: 'e2e-orchestrator' });
    const wsContext = {
      ...ctx,
      host: 'ws',
      hostContext: {
        host: 'ws', channelPath: '/session/:sessionId', connectionId: 'agent-e2e-plan',
        clientIp: '127.0.0.1', headers: {}, params: { sessionId: session.id },
        requestId: 'agent-e2e-plan-request', traceId: 'agent-e2e-plan-trace',
      },
    } satisfies PluginContextV3;
    const sender: WSSender = {
      send: async (message) => { messages.push(message); },
      broadcast: async (message) => { messages.push(message); },
      sendTo: async (_ids, message) => { messages.push(message); },
      close: vi.fn(),
      getConnectionId: () => 'agent-e2e-plan',
    };
    const server = Fastify({ logger: false });
    const sessionPath = { sessionId: session.id };

    try {
      await sessionStreamHandler.execute(wsContext, { event: 'connect', sender } satisfies WSInput);
      await mountRoutes(server, runManifest([
        AGENTS_ROUTES.RUN,
        AGENTS_ROUTES.SESSION_PLAN_APPROVE,
        AGENTS_ROUTES.SESSION_PLAN_EXECUTE,
      ]), {
        backend: runBackend(ctx),
        pluginRoot: path.resolve('plugins/agents/entry'),
        workspaceRoot: workingDir,
        basePath: AGENTS_BASE_PATH,
      });

      const draftResponse = await server.inject({
        method: 'POST', url: `${AGENTS_BASE_PATH}${AGENTS_ROUTES.RUN}`,
        payload: { task, sessionId: session.id, tier: 'small', mode: 'plan' } satisfies RunRequest,
      });
      expect(draftResponse.statusCode).toBe(200);
      const draftRun = draftResponse.json<{ runId: string }>();
      const draftCompletion = await waitForMessage(messages, (message) =>
        message.type === 'run:completed' && message.payload.runId === draftRun.runId,
      );
      expect(draftCompletion.payload).toMatchObject({ runId: draftRun.runId, success: true });
      expect(JSON.stringify(draftCompletion.payload)).toContain('Awaiting approval');

      const planResponse = await server.inject({
        method: 'POST', url: buildRestRoute('SESSION_PLAN_APPROVE', sessionPath), payload: { comment: 'Looks good' },
      });
      expect(planResponse.statusCode).toBe(200);
      expect(planResponse.json<{ plan: { status: string } }>().plan.status).toBe('approved');

      const executeResponse = await server.inject({
        method: 'POST', url: buildRestRoute('SESSION_PLAN_EXECUTE', sessionPath), payload: { tier: 'small' },
      });
      expect(executeResponse.statusCode).toBe(200);
      const executeRun = executeResponse.json<{ runId: string; status: string }>();
      expect(executeRun.status).toBe('started');
      const executeCompletion = await waitForMessage(messages, (message) =>
        message.type === 'run:completed' && message.payload.runId === executeRun.runId,
      );
      expect(executeCompletion.payload).toMatchObject({ runId: executeRun.runId, success: true });
      expect(JSON.stringify(executeCompletion.payload)).toContain('Approved plan executed');

      const marker = await readFile(path.join(workingDir, 'scenario-marker.txt'), 'utf8');
      expect(marker).toBe('done by approved plan\n');
      expect(messages.some((message) => message.type === 'conversation:snapshot')).toBe(true);
      expect(messages.some((message) => message.type === 'turn:delta')).toBe(true);
    } finally {
      await sessionStreamHandler.execute(wsContext, { event: 'disconnect', disconnectCode: 1000, disconnectReason: 'test complete' });
      await server.close();
      cleanup();
    }
  });

  it.skipIf(!isDeepAgentE2EEnabled())('rejects image input before run creation when the tier has no vision capability', async () => {
    const workingDir = await createWorkspace();
    const adapter = createScriptedLLM({
      content: 'This must not be called.', model: 'scenario-text-only', usage: { promptTokens: 0, completionTokens: 0 },
    });
    const router = Object.assign(adapter, {
      getConfiguredTier: () => 'small' as const,
      resolve: () => ({ provider: 'scenario', model: 'scenario-text-only', resource: 'llm:scenario', requestedTier: 'small' as const, actualTier: 'small' as const, adapted: false }),
      resolveAdapter: async () => ({ adapter, model: 'scenario-text-only', tier: 'small' as const }),
      hasCapability: () => false,
      getCapabilities: () => [],
      supportsCapabilities: () => false,
    }) satisfies ILLM & ILLMRouter;
    const { ctx, cleanup } = createTestContext({
      pluginId: '@kb-labs/agents', pluginVersion: 'e2e', host: 'rest', cwd: workingDir, platform: { llm: router },
    });
    const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const server = Fastify({ logger: false });

    try {
      await mountRoutes(server, runManifest(), {
        backend: runBackend(ctx),
        pluginRoot: path.resolve('plugins/agents/entry'),
        workspaceRoot: workingDir,
        basePath: AGENTS_BASE_PATH,
      });
      const response = await server.inject({
        method: 'POST', url: `${AGENTS_BASE_PATH}${AGENTS_ROUTES.RUN}`,
        payload: {
          task: 'Describe this image', tier: 'small',
          attachments: [{ name: 'screen.png', mediaType: 'image/png', data: pngSignature.toString('base64') }],
        } satisfies RunRequest,
      });

      expect(response.statusCode).toBe(400);
      expect(response.body).toContain('AGENT_ATTACHMENT_MODEL_UNSUPPORTED');
      expect(adapter.chatWithTools).not.toHaveBeenCalled();
    } finally {
      await server.close();
      cleanup();
    }
  });

  it.skipIf(!isDeepAgentE2EEnabled())('ends the WS run with a visible failure when the LLM transport rejects', async () => {
    const workingDir = await createWorkspace();
    const llm = createScriptedLLM({
      content: '', model: 'scenario-unavailable', usage: { promptTokens: 0, completionTokens: 0 },
    });
    vi.mocked(llm.chatWithTools).mockRejectedValue(new Error('VibeProxy returned ECONNREFUSED'));
    const eventBus = createEventBus();
    const { ctx, cleanup } = createTestContext({
      pluginId: '@kb-labs/agents', pluginVersion: 'e2e', host: 'rest', cwd: workingDir,
      platform: { llm, eventBus },
    });
    const messages: WSMessage[] = [];
    const session = await new SessionManager(workingDir).createSession({ mode: 'execute', task: 'Проверка отказа LLM', agentId: 'e2e-orchestrator' });
    const wsContext = {
      ...ctx,
      host: 'ws',
      hostContext: {
        host: 'ws', channelPath: '/session/:sessionId', connectionId: 'agent-e2e-failure',
        clientIp: '127.0.0.1', headers: {}, params: { sessionId: session.id },
        requestId: 'agent-e2e-failure-request', traceId: 'agent-e2e-failure-trace',
      },
    } satisfies PluginContextV3;
    const sender: WSSender = {
      send: async (message) => { messages.push(message); },
      broadcast: async (message) => { messages.push(message); },
      sendTo: async (_ids, message) => { messages.push(message); },
      close: vi.fn(),
      getConnectionId: () => 'agent-e2e-failure',
    };
    const server = Fastify({ logger: false });

    try {
      await sessionStreamHandler.execute(wsContext, { event: 'connect', sender } satisfies WSInput);
      await mountRoutes(server, runManifest(), {
        backend: runBackend(ctx),
        pluginRoot: path.resolve('plugins/agents/entry'),
        workspaceRoot: workingDir,
        basePath: AGENTS_BASE_PATH,
      });
      const response = await server.inject({
        method: 'POST', url: `${AGENTS_BASE_PATH}${AGENTS_ROUTES.RUN}`,
        payload: { task: 'Проверка отказа LLM', sessionId: session.id, tier: 'small' } satisfies RunRequest,
      });

      expect(response.statusCode).toBe(200);
      const run = response.json<{ runId: string }>();
      const completion = await waitForMessage(messages, (message) => message.type === 'run:completed');
      expect(completion.payload).toMatchObject({ runId: run.runId, success: false });
      expect(JSON.stringify(completion.payload)).toContain('VibeProxy returned ECONNREFUSED');
      expect(RunManager.get(run.runId)?.status).toBe('failed');
    } finally {
      await sessionStreamHandler.execute(wsContext, { event: 'disconnect', disconnectCode: 1000, disconnectReason: 'test complete' });
      await server.close();
      cleanup();
    }
  });
});
