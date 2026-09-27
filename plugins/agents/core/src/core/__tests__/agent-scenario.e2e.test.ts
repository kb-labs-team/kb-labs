import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ILLM, LLMMessage, LLMToolCallOptions, LLMToolCallResponse } from '@kb-labs/sdk';
import type { AgentEvent, ToolPack } from '@kb-labs/agent-contracts';
import { AgentSDK } from '@kb-labs/agent-sdk';
import { isDeepAgentE2EEnabled } from '@kb-labs/shared-testing-e2e';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootstrapAgentSDK } from '../bootstrap.js';

const mockLLMAccess = vi.hoisted(() => ({
  getLLM: vi.fn<() => ILLM>(),
}));

vi.mock('@kb-labs/sdk', async (importOriginal) => {
  const sdk = await importOriginal<typeof import('@kb-labs/sdk')>();
  return {
    ...sdk,
    useLLM: mockLLMAccess.getLLM,
    useLogger: () => ({
      debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({
        debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => undefined,
      }),
    }),
  };
});

const tempDirs: string[] = [];

async function createWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agents-e2e-'));
  tempDirs.push(dir);
  return dir;
}

function scriptedLLM(responses: LLMToolCallResponse[]): ILLM {
  const calls: LLMToolCallResponse[] = [...responses];
  const requests: LLMMessage[][] = [];
  const chatWithTools = vi.fn(async (messages: LLMMessage[], _options: LLMToolCallOptions): Promise<LLMToolCallResponse> => {
    requests.push(messages);
    const next = calls.shift();
    return next ?? responses.at(-1) ?? {
      content: 'Scenario fallback response.',
      model: 'scenario-fallback',
      usage: { promptTokens: 1, completionTokens: 1 },
    };
  });

  return Object.assign({
    complete: vi.fn(async () => ({ content: '', usage: { promptTokens: 0, completionTokens: 0 }, model: 'scenario' })),
    stream: async function* () { yield ''; },
    chatWithTools,
  }, { requests });
}

const fixturePack: ToolPack = {
  id: 'e2e-fixture',
  namespace: 'fixture',
  version: '1.0.0',
  priority: 10,
  conflictPolicy: 'error',
  tools: [{
    definition: {
      type: 'function',
      function: {
        name: 'record_observation',
        description: 'Record a deterministic test observation.',
        parameters: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] },
      },
    },
    async execute(input) {
      return { success: true, output: `recorded:${String(input.note)}` };
    },
  }],
};

describe('agent scenario E2E foundation', () => {
  afterEach(async () => {
    mockLLMAccess.getLLM.mockReset();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('runs a real agent cycle through a tool, emits events, and persists session evidence', async () => {
    const workingDir = await createWorkspace();
    const events: AgentEvent[] = [];
    const llm = scriptedLLM([
      {
        content: '',
        model: 'scenario-small',
        usage: { promptTokens: 8, completionTokens: 3 },
        toolCalls: [{ id: 'call-1', name: 'record_observation', input: { note: 'first-pass' } }],
      },
      {
        content: 'The observation was recorded.',
        model: 'scenario-small',
        usage: { promptTokens: 13, completionTokens: 7 },
      },
      {
        content: 'The observation was recorded.',
        model: 'scenario-small',
        usage: { promptTokens: 13, completionTokens: 7 },
      },
    ]);
    mockLLMAccess.getLLM.mockReturnValue(llm);
    bootstrapAgentSDK();

    const runner = new AgentSDK()
      .register(fixturePack)
      .createRunner({
        workingDir,
        sessionId: 'scenario-tool-cycle',
        agentId: 'scenario-orchestrator',
        maxIterations: 4,
        temperature: 0,
        tier: 'small',
        mode: { mode: 'execute', context: { mode: 'execute', task: 'Record the observation and report back.' } },
        onEvent: (event) => events.push(event),
      });

    const result = await runner.execute('Record the observation and report back.');

    expect(result.success).toBe(true);
    expect(result.summary).toContain('observation was recorded');
    // Runner middleware can make additional tool-capable calls (classification,
    // reflection, synthesis); assert the real cycle happened without pinning
    // the test to a particular middleware call count.
    expect(llm.chatWithTools).toHaveBeenCalled();
    expect(events.some((event) => event.type === 'tool:start')).toBe(true);
    expect(events.some((event) => event.type === 'tool:end')).toBe(true);
    expect(events.some((event) => event.type === 'agent:end')).toBe(true);

    const toolLedger = await readFile(path.join(workingDir, '.kb', 'agents', 'sessions', 'scenario-tool-cycle', 'tool-ledger.jsonl'), 'utf8');
    expect(toolLedger).toContain('record_observation');
    expect(toolLedger).toContain('first-pass');
  });

  it.skipIf(!isDeepAgentE2EEnabled())('escalates from small to medium and completes the request', async () => {
    const workingDir = await createWorkspace();
    const events: AgentEvent[] = [];
    const llm = scriptedLLM([{
      content: 'The request is complete at the higher tier.',
      model: 'scenario-medium',
      usage: { promptTokens: 12, completionTokens: 6 },
    }]);
    mockLLMAccess.getLLM.mockReturnValue(llm);
    bootstrapAgentSDK();

    let firstIteration = true;
    const runner = new AgentSDK()
      .use({
        name: 'scenario-escalation',
        order: 100,
        beforeIteration: () => {
          if (firstIteration) {
            firstIteration = false;
            return 'escalate';
          }
          return 'continue';
        },
      })
      .createRunner({
        workingDir,
        agentId: 'scenario-escalation-agent',
        maxIterations: 3,
        temperature: 0,
        tier: 'small',
        onEvent: (event) => events.push(event),
      });

    const result = await runner.execute('Answer this request accurately.');

    expect(result.success).toBe(true);
    expect(result.summary).toContain('higher tier');
    expect(mockLLMAccess.getLLM.mock.calls).toContainEqual([{ tier: 'small' }]);
    expect(mockLLMAccess.getLLM.mock.calls).toContainEqual([{ tier: 'medium' }]);
    expect(events.some((event) => event.type === 'status:change' && event.data?.status === 'escalating')).toBe(true);
  });

  it.skipIf(!isDeepAgentE2EEnabled())('keeps prior conversation turns when continuing a long-lived session', async () => {
    const workingDir = await createWorkspace();
    const sessionId = 'scenario-long-session';
    const llm = scriptedLLM([
      ...Array.from({ length: 12 }, (_, index) => ({
        content: index < 6 ? 'The agreed project codename is Silver Birch.' : 'The saved codename is Silver Birch.',
        model: 'scenario-small',
        usage: { promptTokens: 10, completionTokens: 8 },
      })),
    ]);
    mockLLMAccess.getLLM.mockReturnValue(llm);
    bootstrapAgentSDK();

    const firstRun = new AgentSDK().createRunner({
      workingDir,
      sessionId,
      agentId: 'scenario-long-session-agent',
      maxIterations: 3,
      temperature: 0,
      tier: 'small',
      mode: { mode: 'execute', context: { mode: 'execute', task: 'Remember the codename Silver Birch.' } },
    });
    expect((await firstRun.execute('Remember the codename Silver Birch.')).success).toBe(true);

    const followUp = new AgentSDK().createRunner({
      workingDir,
      sessionId,
      agentId: 'scenario-long-session-agent',
      maxIterations: 3,
      temperature: 0,
      tier: 'small',
      mode: { mode: 'execute', context: { mode: 'execute', task: 'What codename did I ask you to remember?' } },
    });
    expect((await followUp.execute('What codename did I ask you to remember?')).success).toBe(true);

    const lastRequest = llm.requests.at(-1) ?? [];
    expect(JSON.stringify(lastRequest)).toContain('Remember the codename Silver Birch.');
    expect(JSON.stringify(lastRequest)).toContain('The agreed project codename is Silver Birch.');
  });
});
