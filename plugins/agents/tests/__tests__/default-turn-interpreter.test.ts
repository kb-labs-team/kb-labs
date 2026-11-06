import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultTurnInterpreter } from '../../src/runtime/default-turn-interpreter.js';

const chatWithTools = vi.fn();

vi.mock('@kb-labs/sdk/hooks', () => ({
  useLLM: vi.fn(() => ({
    chatWithTools,
  })),
}));

describe('createDefaultTurnInterpreter', () => {
  beforeEach(() => {
    chatWithTools.mockReset();
  });

  it('uses a structured LLM pass when available', async () => {
    chatWithTools.mockResolvedValue({
      content: '',
      toolCalls: [
        {
          id: 'tc-1',
          name: 'interpret_turn',
          input: {
            kind: 'constraint',
            shouldPersist: true,
            persistenceKind: 'constraint',
            content: 'Only answer questions about previous shell commands in this session.',
            confidence: 0.96,
            suggestedSkills: ['shell-recall'],
            suggestedPromptProfile: 'session-recall',
            rationale: 'User provided a lasting session instruction.',
          },
        },
      ],
    });

    const interpreter = createDefaultTurnInterpreter();
    const result = await interpreter.interpret({
      mode: 'assistant',
      message: 'From now on, only answer questions about previous shell commands in this session.',
      kernel: null,
    });

    expect(result).toMatchObject({
      kind: 'constraint',
      shouldPersist: true,
      persistenceKind: 'constraint',
      suggestedSkills: ['shell-recall'],
      suggestedPromptProfile: 'session-recall',
      confidence: 0.96,
    });
    expect(chatWithTools).toHaveBeenCalledTimes(1);
  });

  it('preserves explicit persist strategy from the LLM response', async () => {
    chatWithTools.mockResolvedValue({
      content: '',
      toolCalls: [
        {
          id: 'tc-1',
          name: 'interpret_turn',
          input: {
            kind: 'constraint',
            shouldPersist: true,
            persistenceKind: 'constraint',
            persistStrategy: 'explicit_commit',
            content: 'Only answer questions about previous shell commands in this session.',
            confidence: 0.96,
          },
        },
      ],
    });

    const interpreter = createDefaultTurnInterpreter();
    const result = await interpreter.interpret({
      mode: 'assistant',
      message: 'From now on, only answer questions about previous shell commands in this session.',
      kernel: null,
    });

    expect(result?.persistStrategy).toBe('explicit_commit');
  });

  it('falls back to heuristic interpretation when the LLM step fails', async () => {
    chatWithTools.mockRejectedValue(new Error('provider unavailable'));

    const interpreter = createDefaultTurnInterpreter();
    const result = await interpreter.interpret({
      mode: 'assistant',
      message: 'From now on, do not touch files outside this package.',
      kernel: null,
    });

    expect(result).toMatchObject({
      kind: 'constraint',
      shouldPersist: true,
      persistenceKind: 'constraint',
      confidence: 0.55,
    });
  });
});
