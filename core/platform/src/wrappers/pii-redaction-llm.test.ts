/**
 * Tests for PIIRedactionLLM — ILLM wrapper with PII masking.
 */

import { describe, it, expect, vi } from 'vitest';
import { PIIRedactionLLM, createPIIRedactionLLM } from './pii-redaction-llm.js';
import type { ILLM, LLMResponse, LLMToolCallResponse, LLMMessage } from '../adapters/llm.js';

// ── Mock LLM ─────────────────────────────────────────────────────────────────

function createMockLLM(overrides: Partial<ILLM> = {}): ILLM {
  const defaultResponse: LLMResponse = {
    content: 'Response text',
    usage: { promptTokens: 10, completionTokens: 5 },
    model: 'gpt-4o-mini',
  };

  return {
    complete: vi.fn(async () => defaultResponse),
    stream: vi.fn(async function* () { yield 'chunk'; }),
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('PIIRedactionLLM', () => {
  it('preserves router capability preflight through the wrapper', () => {
    const supportsCapabilities = vi.fn(() => true);
    const mockLLM = Object.assign(createMockLLM(), { supportsCapabilities });
    const wrapper = new PIIRedactionLLM(mockLLM);

    expect(wrapper.supportsCapabilities({ tier: 'small', capabilities: ['vision'] })).toBe(true);
    expect(supportsCapabilities).toHaveBeenCalledWith({ tier: 'small', capabilities: ['vision'] });
  });

  describe('complete()', () => {
    it('should redact PII from prompt before sending to LLM', async () => {
      const mockLLM = createMockLLM();
      const wrapper = new PIIRedactionLLM(mockLLM);

      await wrapper.complete('Send email to john@example.com');

      const calledPrompt = (mockLLM.complete as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(calledPrompt).not.toContain('john@example.com');
      expect(calledPrompt).toContain('[PII_001]');
    });

    it('should restore PII in response', async () => {
      const mockLLM = createMockLLM({
        complete: vi.fn(async () => ({
          content: 'Email sent to [PII_001]',
          usage: { promptTokens: 10, completionTokens: 5 },
          model: 'gpt-4o-mini',
        })),
      });
      const wrapper = new PIIRedactionLLM(mockLLM);

      const response = await wrapper.complete('Send email to john@example.com');
      expect(response.content).toBe('Email sent to john@example.com');
    });

    it('should pass through when no PII found', async () => {
      const mockLLM = createMockLLM();
      const wrapper = new PIIRedactionLLM(mockLLM);

      await wrapper.complete('Hello world');

      const calledPrompt = (mockLLM.complete as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(calledPrompt).toBe('Hello world');
    });

    it('preserves a non-enumerable cancellation signal when redacting the system prompt', async () => {
      const mockLLM = createMockLLM();
      const wrapper = new PIIRedactionLLM(mockLLM);
      const controller = new AbortController();
      const options = { systemPrompt: 'Verify the answer.' };
      Object.defineProperty(options, 'signal', { value: controller.signal, enumerable: false });

      await wrapper.complete('Check this answer.', options);

      const passedOptions = (mockLLM.complete as ReturnType<typeof vi.fn>).mock.calls[0]![1];
      expect(passedOptions?.signal).toBe(controller.signal);
      expect(Object.keys(passedOptions ?? {})).not.toContain('signal');
    });

    it('should not restore in one-way mode', async () => {
      const mockLLM = createMockLLM({
        complete: vi.fn(async () => ({
          content: 'Email sent to [REDACTED_001]',
          usage: { promptTokens: 10, completionTokens: 5 },
          model: 'gpt-4o-mini',
        })),
      });
      const wrapper = new PIIRedactionLLM(mockLLM, { mode: 'one-way' });

      const response = await wrapper.complete('Send email to john@example.com');
      // In one-way mode, placeholders stay
      expect(response.content).toBe('Email sent to [REDACTED_001]');
    });
  });

  describe('chatWithTools()', () => {
    it('should redact PII in messages and restore in response', async () => {
      const toolResponse: LLMToolCallResponse = {
        content: 'I found [PII_001] in the database',
        usage: { promptTokens: 20, completionTokens: 10 },
        model: 'gpt-4o-mini',
        toolCalls: [
          { id: 'call_1', name: 'search', input: { query: '[PII_001]' } },
        ],
      };

      const mockLLM = createMockLLM({
        chatWithTools: vi.fn(async () => toolResponse),
      });
      const wrapper = new PIIRedactionLLM(mockLLM);

      const messages: LLMMessage[] = [
        { role: 'user', content: 'Find user john@example.com' },
      ];

      const response = await wrapper.chatWithTools(messages, {
        tools: [{ name: 'search', description: 'Search', inputSchema: {} }],
      });

      // Messages sent to LLM should be redacted
      const sentMessages = (mockLLM.chatWithTools as ReturnType<typeof vi.fn>).mock.calls[0]![0] as LLMMessage[];
      expect(sentMessages[0]!.content).not.toContain('john@example.com');
      expect(sentMessages[0]!.content).toContain('[PII_001]');

      // Response should have PII restored
      expect(response.content).toBe('I found john@example.com in the database');
      expect((response.toolCalls![0]!.input as any).query).toBe('john@example.com');
    });

    it('should use consistent placeholders across messages', async () => {
      const mockLLM = createMockLLM({
        chatWithTools: vi.fn(async () => ({
          content: 'ok',
          usage: { promptTokens: 10, completionTokens: 5 },
          model: 'gpt-4o-mini',
        })),
      });
      const wrapper = new PIIRedactionLLM(mockLLM);

      const messages: LLMMessage[] = [
        { role: 'user', content: 'User is john@example.com' },
        { role: 'assistant', content: 'Looking up john@example.com' },
        { role: 'tool', content: 'Found: john@example.com, active', toolCallId: 'c1' },
      ];

      await wrapper.chatWithTools(messages, {
        tools: [{ name: 't', description: 'd', inputSchema: {} }],
      });

      const sent = (mockLLM.chatWithTools as ReturnType<typeof vi.fn>).mock.calls[0]![0] as LLMMessage[];
      // All three messages should use the same placeholder for the same email
      const placeholder = '[PII_001]';
      expect(sent[0]!.content).toContain(placeholder);
      expect(sent[1]!.content).toContain(placeholder);
      expect(sent[2]!.content).toContain(placeholder);
    });

    it('should throw if underlying LLM does not support chatWithTools', async () => {
      const mockLLM = createMockLLM();
      // No chatWithTools on mock
      const wrapper = new PIIRedactionLLM(mockLLM);

      await expect(
        wrapper.chatWithTools(
          [{ role: 'user', content: 'hi' }],
          { tools: [] },
        ),
      ).rejects.toThrow('does not support chatWithTools');
    });
  });

  describe('stream()', () => {
    it('should redact PII in prompt and restore in chunks', async () => {
      const mockLLM = createMockLLM({
        stream: vi.fn(async function* () {
          yield 'Sent to ';
          yield '[PII_001]';
          yield ' done';
        }),
      });
      const wrapper = new PIIRedactionLLM(mockLLM);

      const chunks: string[] = [];
      for await (const chunk of wrapper.stream('Email john@example.com')) {
        chunks.push(chunk);
      }

      const full = chunks.join('');
      expect(full).toContain('john@example.com');

      // Verify prompt was redacted
      const calledPrompt = (mockLLM.stream as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(calledPrompt).not.toContain('john@example.com');
    });

    it('should pass through without buffering when no PII', async () => {
      const mockLLM = createMockLLM({
        stream: vi.fn(async function* () {
          yield 'Hello ';
          yield 'world';
        }),
      });
      const wrapper = new PIIRedactionLLM(mockLLM);

      const chunks: string[] = [];
      for await (const chunk of wrapper.stream('Hello world')) {
        chunks.push(chunk);
      }

      expect(chunks.join('')).toBe('Hello world');
    });
  });

  describe('createPIIRedactionLLM()', () => {
    it('should return original LLM when disabled', () => {
      const mockLLM = createMockLLM();
      const result = createPIIRedactionLLM(mockLLM, { enabled: false });
      expect(result).toBe(mockLLM);
    });

    it('should return original LLM when no config', () => {
      const mockLLM = createMockLLM();
      const result = createPIIRedactionLLM(mockLLM);
      expect(result).toBe(mockLLM);
    });

    it('should return wrapped LLM when enabled', () => {
      const mockLLM = createMockLLM();
      const result = createPIIRedactionLLM(mockLLM, { enabled: true });
      expect(result).toBeInstanceOf(PIIRedactionLLM);
    });
  });

  describe('systemPrompt redaction', () => {
    it('should redact PII in systemPrompt option', async () => {
      const mockLLM = createMockLLM();
      const wrapper = new PIIRedactionLLM(mockLLM);

      await wrapper.complete('Hello', {
        systemPrompt: 'User email is admin@corp.com',
      });

      const calledOptions = (mockLLM.complete as ReturnType<typeof vi.fn>).mock.calls[0]![1];
      expect(calledOptions.systemPrompt).not.toContain('admin@corp.com');
      expect(calledOptions.systemPrompt).toContain('[PII_001]');
    });
  });
});
