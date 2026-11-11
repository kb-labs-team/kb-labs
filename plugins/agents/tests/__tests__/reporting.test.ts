import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createReportTool } from '../../src/tools/tools/interaction/reporting.js';
import type { ToolContext } from '../../src/tools/types.js';

const completeMock = vi.fn();

vi.mock('@kb-labs/sdk/hooks', () => ({
  useLLM: () => ({
    complete: completeMock,
  }),
}));

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDir: '/tmp/project',
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

    const tool = createReportTool(makeContext());
    const result = await tool.executor({
      answer: 'RuntimeEngine orchestrates kernel compaction and prompt routing.',
      confidence: 0.9,
    });

    expect(result.success).toBe(false);
    expect(result.metadata?.code).toBe('INSUFFICIENT_EVIDENCE');
    expect(String(result.output)).toContain('not sufficiently supported');
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
});
