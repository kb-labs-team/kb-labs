import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultPromptContextSelector } from '../../src/runtime/default-prompt-context-selector.js';

const complete = vi.fn();

vi.mock('@kb-labs/sdk/hooks', () => ({
  useLLM: () => ({
    complete,
  }),
}));

describe('createDefaultPromptContextSelector', () => {
  beforeEach(() => {
    complete.mockReset();
  });

  it('prefers evidence/tool usage over working summary for recall-like follow-ups', async () => {
    complete.mockRejectedValue(new Error('provider unavailable'));

    const selector = createDefaultPromptContextSelector();
    const selection = await selector.select({
      state: {
        version: 1,
        sessionId: 'session-test',
        workingDir: '/tmp/project',
        mode: 'assistant',
        currentTask: 'Inspect runtime file',
        objective: 'Inspect runtime file',
        constraints: [],
        memory: {
          corrections: [],
          assumptions: [],
          decisions: [],
          evidence: [{
            id: 'ev-1',
            summary: 'Read runtime file',
            source: 'fs_read',
            createdAt: new Date().toISOString(),
            toolName: 'fs_read',
            toolInputSummary: 'packages/agent-runtime/src/index.ts',
          }],
          openQuestions: [],
          pendingActions: [],
          latestSummary: 'Long prose answer about runtime responsibilities.',
        },
        childResults: [],
        updatedAt: new Date().toISOString(),
      },
      messages: [
        {
          role: 'user',
          content: 'Which files have you inspected so far in this session?',
        },
      ],
    });

    expect(selection.includeEvidence).toBe(true);
    expect(selection.includePreviousRunToolUsage).toBe(true);
    expect(selection.includeWorkingSummary).toBe(false);
    expect(selection.includeSessionRollup).toBe(false);
  });

  it('uses response requirements to force recall-oriented context selection', async () => {
    complete.mockRejectedValue(new Error('provider unavailable'));

    const selector = createDefaultPromptContextSelector();
    const selection = await selector.select({
      state: {
        version: 1,
        sessionId: 'session-test',
        workingDir: '/tmp/project',
        mode: 'assistant',
        currentTask: 'Inspect four files',
        objective: 'Inspect four files',
        constraints: [],
        memory: {
          corrections: [],
          assumptions: [],
          decisions: [],
          evidence: [],
          openQuestions: [],
          pendingActions: [],
          latestSummary: 'Long prose answer.',
        },
        childResults: [],
        updatedAt: new Date().toISOString(),
      },
      messages: [{ role: 'user', content: 'Which files did you inspect, exactly?' }],
      responseRequirements: {
        requirements: {
          allowsMemoryOnlyRecall: true,
          needsDirectToolEvidence: true,
          needsFileBackedClaims: false,
          allowsInference: false,
          maxUnsupportedClaims: 0,
        },
        rationale: 'Recall should be answered from stored evidence.',
      },
    });

    expect(selection.includeEvidence).toBe(true);
    expect(selection.includePreviousRunToolUsage).toBe(true);
    expect(selection.includeWorkingSummary).toBe(false);
    expect(selection.rationale).toContain('Recall');
  });
});
