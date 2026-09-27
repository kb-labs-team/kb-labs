import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createReportTool } from '../interaction/reporting.js';
import type { ToolContext } from '../../types.js';

const completeMock = vi.fn();

vi.mock('@kb-labs/sdk/hooks', () => ({
  useLLM: () => ({
    complete: completeMock,
  }),
}));

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDir: '/tmp/project',
    runEvidence: [],
    sessionMemory: {
      async loadKernelState() {
        return {
          version: 1,
          sessionId: 'session-test',
          workingDir: '/tmp/project',
          mode: 'assistant',
          currentTask: 'test',
          objective: 'test',
          constraints: [],
          memory: {
            corrections: [],
            assumptions: [],
            decisions: [],
            evidence: [],
            openQuestions: [],
            pendingActions: [],
          },
          childResults: [],
          updatedAt: new Date().toISOString(),
        };
      },
      async recordConstraint() {
        throw new Error('not used');
      },
      async recordCorrection() {
        throw new Error('not used');
      },
    },
    ...overrides,
  };
}

describe('createReportTool', () => {
  beforeEach(() => {
    completeMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('blocks report when claim verifier finds unsupported code claims', async () => {
    completeMock.mockResolvedValue({
      content: JSON.stringify({
        verdict: 'block',
        rationale: 'The answer makes architecture claims that are not backed by the provided evidence.',
        requirements: {
          allowsMemoryOnlyRecall: false,
          needsDirectToolEvidence: true,
          needsFileBackedClaims: true,
          allowsInference: false,
          maxUnsupportedClaims: 0,
        },
        supportedClaims: [],
        unsupportedClaims: ['RuntimeEngine orchestrates kernel compaction.'],
      }),
    });

    const tool = createReportTool(makeContext({ filesWritten: new Set(['src/example.ts']) }));
    const result = await tool.executor({
      answer: 'RuntimeEngine orchestrates kernel compaction and prompt routing.',
      confidence: 0.9,
    });

    expect(result.success).toBe(false);
    expect(result.metadata?.code).toBe('INSUFFICIENT_EVIDENCE');
    expect(String(result.output)).toContain('not sufficiently supported');
  });

  it('skips verification for any response when the run produced no artifacts', async () => {
    const tool = createReportTool(makeContext({ currentTask: 'Explain what an agent does.' }));
    const result = await tool.executor({ answer: 'An agent works through a task and reports the result.', confidence: 0.99 });

    expect(result.success).toBe(true);
    expect(completeMock).not.toHaveBeenCalled();
  });

  it('allows report when verifier marks shell recall as supported', async () => {
    completeMock.mockResolvedValue({
      content: JSON.stringify({
        verdict: 'allow',
        rationale: 'Shell recall is supported by stored shell_exec evidence.',
        requirements: {
          allowsMemoryOnlyRecall: true,
          needsDirectToolEvidence: false,
          needsFileBackedClaims: false,
          allowsInference: false,
          maxUnsupportedClaims: 0,
        },
        supportedClaims: ['The latest shell command was pwd.'],
        unsupportedClaims: [],
      }),
    });

    const tool = createReportTool(makeContext({
      filesWritten: new Set(['src/example.ts']),
      runEvidence: [{
        id: 'ev-shell-current', summary: 'Command pwd -> /tmp/project', source: 'shell_exec',
        createdAt: new Date().toISOString(), toolName: 'shell_exec', toolInputSummary: 'pwd',
      }],
      sessionMemory: {
        async loadKernelState() {
          return {
            version: 1,
            sessionId: 'session-test',
            workingDir: '/tmp/project',
            mode: 'assistant',
            currentTask: 'test',
            objective: 'test',
            constraints: [],
            memory: {
              corrections: [],
              assumptions: [],
              decisions: [],
              evidence: [{
                id: 'ev-1',
                summary: 'Command pwd -> /tmp/project',
                source: 'shell_exec',
                createdAt: new Date().toISOString(),
                toolName: 'shell_exec',
                toolInputSummary: 'pwd',
              }],
              openQuestions: [],
              pendingActions: [],
            },
            childResults: [],
            updatedAt: new Date().toISOString(),
          };
        },
        async recordConstraint() {
          throw new Error('not used');
        },
        async recordCorrection() {
          throw new Error('not used');
        },
      },
    }));

    const result = await tool.executor({
      answer: 'The latest shell command used in this session was `pwd`.',
      confidence: 0.95,
    });

    expect(result.success).toBe(true);
    expect(result.metadata?.verification).toBeTruthy();
  });

  it('allows file recall from existing fs_read evidence without forcing reread', async () => {
    completeMock.mockResolvedValue({
      content: JSON.stringify({
        verdict: 'allow',
        rationale: 'File recall is supported by stored fs_read evidence.',
        requirements: {
          allowsMemoryOnlyRecall: true,
          needsDirectToolEvidence: true,
          needsFileBackedClaims: false,
          allowsInference: false,
          maxUnsupportedClaims: 0,
        },
        supportedClaims: ['Read evidence exists for plugins/kb-labs-agents/packages/agent-runtime/src/index.ts'],
        unsupportedClaims: [],
      }),
    });

    const tool = createReportTool(makeContext({
      filesWritten: new Set(['src/example.ts']),
      runEvidence: [{
        id: 'ev-file-current', summary: 'Read a source file', source: 'fs_read',
        createdAt: new Date().toISOString(), toolName: 'fs_read',
        toolInputSummary: 'plugins/kb-labs-agents/packages/agent-runtime/src/index.ts',
      }],
      currentTask: 'Which files did you inspect, exactly?',
      responseRequirementsResolver: async ({ kernel }) => ({
        requirements: {
          allowsMemoryOnlyRecall: true,
          needsDirectToolEvidence: true,
          needsFileBackedClaims: false,
          allowsInference: false,
          maxUnsupportedClaims: 0,
        },
        rationale: 'Session recall should be answerable from fs_read evidence.',
      }),
      sessionMemory: {
        async loadKernelState() {
          return {
            version: 1,
            sessionId: 'session-test',
            workingDir: '/tmp/project',
            mode: 'assistant',
            currentTask: 'Which files did you inspect, exactly?',
            objective: 'Which files did you inspect, exactly?',
            constraints: [],
            memory: {
              corrections: [],
              assumptions: [],
              decisions: [],
              evidence: [{
                id: 'ev-file',
                summary: 'Read plugins/kb-labs-agents/packages/agent-runtime/src/index.ts',
                source: 'fs_read',
                createdAt: new Date().toISOString(),
                toolName: 'fs_read',
                toolInputSummary: 'plugins/kb-labs-agents/packages/agent-runtime/src/index.ts',
              }],
              openQuestions: [],
              pendingActions: [],
            },
            childResults: [],
            updatedAt: new Date().toISOString(),
          };
        },
        async recordConstraint() {
          throw new Error('not used');
        },
        async recordCorrection() {
          throw new Error('not used');
        },
      },
    }));

    const result = await tool.executor({
      answer: 'I inspected plugins/kb-labs-agents/packages/agent-runtime/src/index.ts.',
      confidence: 0.95,
    });

    expect(result.success).toBe(true);
    expect((result.metadata as { verification?: { rationale?: string } }).verification?.rationale).toContain('stored fs_read evidence');
  });

  it('includes bounded fs_read evidence from the current run in claim verification', async () => {
    completeMock.mockResolvedValue({
      content: JSON.stringify({
        verdict: 'allow',
        rationale: 'The implementation detail is present in the current-run file evidence.',
        requirements: {
          allowsMemoryOnlyRecall: false,
          needsDirectToolEvidence: true,
          needsFileBackedClaims: true,
          allowsInference: false,
          maxUnsupportedClaims: 0,
        },
        supportedClaims: ['Scalar file flag values are normalized to a one-item array.'],
        unsupportedClaims: [],
      }),
    });

    const tool = createReportTool(makeContext({
      filesWritten: new Set(['src/example.ts']),
      responseRequirementsResolver: async () => ({
        requirements: {
          allowsMemoryOnlyRecall: false,
          needsDirectToolEvidence: true,
          needsFileBackedClaims: true,
          allowsInference: false,
          maxUnsupportedClaims: 0,
        },
        rationale: 'Verify implementation claims against produced artifacts.',
      }),
      runEvidence: [{
        id: 'run-ev-1',
        summary: 'File: plugins/agents/entry/src/cli/commands/run.ts\nnormalizeFiles wraps strings in an array.',
        source: 'fs_read',
        createdAt: new Date().toISOString(),
        toolName: 'fs_read',
        toolInputSummary: 'plugins/agents/entry/src/cli/commands/run.ts',
        filePaths: ['plugins/agents/entry/src/cli/commands/run.ts'],
      }],
    }));

    const result = await tool.executor({
      answer: 'The CLI normalizes a scalar --files value in plugins/agents/entry/src/cli/commands/run.ts.',
      confidence: 0.9,
    });

    expect(result.success).toBe(true);
    expect(completeMock.mock.calls[0]?.[0]).toContain('normalizeFiles wraps strings in an array');
  });

  it('aborts the bounded verifier call when the agent run is cancelled', async () => {
    completeMock.mockImplementation((_prompt: string, options: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
      }),
    );
    const controller = new AbortController();
    const tool = createReportTool(makeContext({ abortSignal: controller.signal, filesWritten: new Set(['src/example.ts']) }));

    const pending = tool.executor({
      answer: 'RuntimeEngine performs architecture work in plugins/agents/core/src/core/runner.ts.',
      confidence: 0.8,
    });
    await vi.waitFor(() => expect(completeMock).toHaveBeenCalledOnce());
    controller.abort(new Error('run cancelled'));

    const result = await pending;
    expect(result.success).toBe(false);
    expect(result.metadata?.code).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('falls back when the bounded verifier deadline expires', async () => {
    vi.useFakeTimers();
    let signalReady!: (signal: AbortSignal) => void;
    const started = new Promise<AbortSignal>((resolve) => { signalReady = resolve; });
    completeMock.mockImplementation((_prompt: string, options: { signal?: AbortSignal }) => {
      const signal = options.signal!;
      signalReady(signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const tool = createReportTool(makeContext({ filesWritten: new Set(['src/example.ts']) }));

    const pending = tool.executor({
      answer: 'RuntimeEngine performs architecture work in plugins/agents/core/src/core/runner.ts.',
      confidence: 0.8,
    });
    const signal = await started;
    await vi.advanceTimersByTimeAsync(8_000);

    const result = await pending;
    expect(signal.aborted).toBe(true);
    expect(result.success).toBe(false);
    expect(result.metadata?.code).toBe('INSUFFICIENT_EVIDENCE');
  });
});
