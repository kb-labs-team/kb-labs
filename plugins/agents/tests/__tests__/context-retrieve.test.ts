import { describe, it, expect, beforeEach } from 'vitest';
import {
  executeContextRetrieve,
  formatContextRetrieveResult,
  createContextRetrieveTool,
  type ContextRetrieveInput,
} from '../../src/core/tools/context-retrieve';
import type { LLMMessage } from '@kb-labs/sdk';

describe('context_retrieve tool', () => {
  let mockHistory: LLMMessage[];

  beforeEach(() => {
    mockHistory = [
      {
        role: 'user',
        content: 'Read package.json',
        iteration: 1,
      } as any,
      {
        role: 'tool',
        content: '{"name": "test-package", "version": "1.0.0"}',
        name: 'fs:read',
        tool_call_id: 'call_123',
        iteration: 1,
      } as any,
      {
        role: 'user',
        content: 'Run npm test',
        iteration: 2,
      } as any,
      {
        role: 'tool',
        content: 'Test output: 18/18 passing',
        name: 'shell:exec',
        tool_call_id: 'call_456',
        iteration: 2,
      } as any,
      {
        role: 'assistant',
        content: 'All tests passed!',
        iteration: 2,
      } as any,
    ];
  });

  const getSnapshot = () => mockHistory;

  describe('Tool Definition', () => {
    it('should create valid LLM tool definition', () => {
      const tool = createContextRetrieveTool(getSnapshot);

      // KB Labs internal format (not OpenAI format)
      expect(tool.name).toBe('context_retrieve');
      expect(tool.description).toContain('Retrieve full, non-truncated context');
      expect(tool.inputSchema.properties).toHaveProperty('iteration');
      expect(tool.inputSchema.properties).toHaveProperty('tool_call_id');
      expect(tool.inputSchema.properties).toHaveProperty('topic');
      expect(tool.inputSchema.properties).toHaveProperty('tool_name');
    });
  });

  describe('Filtering by Iteration', () => {
    it('should retrieve messages by iteration number', async () => {
      const input: ContextRetrieveInput = { iteration: 1 };

      const result = await executeContextRetrieve(input, getSnapshot);

      expect(result.success).toBe(true);
      expect(result.count).toBe(2); // user + tool from iteration 1
      expect(result.messages[0]!.content).toContain('package.json');
    });

    it('should return empty for non-existent iteration', async () => {
      const input: ContextRetrieveInput = { iteration: 999 };

      const result = await executeContextRetrieve(input, getSnapshot);

      expect(result.success).toBe(true);
      expect(result.count).toBe(0);
    });
  });

  describe('Filtering by Tool Call ID', () => {
    it('should retrieve message by tool_call_id', async () => {
      const input: ContextRetrieveInput = { tool_call_id: 'call_123' };

      const result = await executeContextRetrieve(input, getSnapshot);

      expect(result.success).toBe(true);
      expect(result.count).toBe(1);
      expect(result.messages[0]!.content).toContain('test-package');
    });

    it('should return empty for non-existent tool_call_id', async () => {
      const input: ContextRetrieveInput = { tool_call_id: 'nonexistent' };

      const result = await executeContextRetrieve(input, getSnapshot);

      expect(result.success).toBe(true);
      expect(result.count).toBe(0);
    });
  });

  describe('Filtering by Tool Name', () => {
    it('should retrieve messages by tool name', async () => {
      const input: ContextRetrieveInput = { tool_name: 'fs:read' };

      const result = await executeContextRetrieve(input, getSnapshot);

      expect(result.success).toBe(true);
      expect(result.count).toBe(1);
      expect(result.messages[0]!.content).toContain('test-package');
    });

    it('should only return tool messages', async () => {
      const input: ContextRetrieveInput = { tool_name: 'shell:exec' };

      const result = await executeContextRetrieve(input, getSnapshot);

      expect(result.success).toBe(true);
      expect(result.count).toBe(1);
      expect(result.messages[0]!.role).toBe('tool');
    });
  });

  describe('Filtering by Topic', () => {
    it('should retrieve messages by topic (case-insensitive)', async () => {
      const input: ContextRetrieveInput = { topic: 'test' };

      const result = await executeContextRetrieve(input, getSnapshot);

      expect(result.success).toBe(true);
      // Should match: "test-package" in tool result + "npm test" in user message + "Test output" in tool result
      expect(result.count).toBeGreaterThanOrEqual(2);
    });

    it('should perform case-insensitive search', async () => {
      const input: ContextRetrieveInput = { topic: 'PACKAGE' };

      const result = await executeContextRetrieve(input, getSnapshot);

      expect(result.success).toBe(true);
      expect(result.count).toBeGreaterThan(0);
    });

    it('should search in tool outputs', async () => {
      const input: ContextRetrieveInput = { topic: 'passing' };

      const result = await executeContextRetrieve(input, getSnapshot);

      expect(result.success).toBe(true);
      expect(result.count).toBe(1);
      expect(result.messages[0]!.content).toContain('18/18 passing');
    });
  });

  describe('Combined Filters', () => {
    it('should combine iteration and tool_name filters', async () => {
      const input: ContextRetrieveInput = {
        iteration: 2,
        tool_name: 'shell:exec',
      };

      const result = await executeContextRetrieve(input, getSnapshot);

      expect(result.success).toBe(true);
      expect(result.count).toBe(1);
      expect(result.messages[0]!.content).toContain('passing');
    });

    it('should combine topic and iteration filters', async () => {
      const input: ContextRetrieveInput = {
        iteration: 1,
        topic: 'test-package',
      };

      const result = await executeContextRetrieve(input, getSnapshot);

      expect(result.success).toBe(true);
      expect(result.count).toBe(1);
    });
  });

  describe('Truncation Removal', () => {
    it('should remove truncation metadata', async () => {
      const truncatedHistory: LLMMessage[] = [
        {
          role: 'tool',
          content: 'x'.repeat(500) + '\n\n... (9500 more chars)',
          metadata: {
            truncated: true,
            originalLength: 10000,
          },
          iteration: 1,
        } as any,
      ];

      const getSnapshot = () => truncatedHistory;
      const input: ContextRetrieveInput = { iteration: 1 };

      const result = await executeContextRetrieve(input, getSnapshot);

      expect(result.success).toBe(true);
      expect(result.messages[0]!.metadata?.truncated).toBeUndefined();
      expect(result.messages[0]!.metadata?.originalLength).toBeUndefined();
    });
  });

  describe('Validation', () => {
    it('should require at least one filter', async () => {
      const input: ContextRetrieveInput = {};

      const result = await executeContextRetrieve(input, getSnapshot);

      expect(result.success).toBe(false);
      expect(result.error).toContain('At least one filter');
    });
  });

  describe('Result Formatting', () => {
    it('should format successful result', async () => {
      const input: ContextRetrieveInput = { iteration: 1 };
      const result = await executeContextRetrieve(input, getSnapshot);

      const formatted = formatContextRetrieveResult(result);

      expect(formatted).toContain('Found 2 message(s)');
      expect(formatted).toContain('Iteration 1');
      expect(formatted).toContain('package.json');
    });

    it('should format error result', () => {
      const result = {
        success: false,
        messages: [],
        count: 0,
        error: 'Test error',
      };

      const formatted = formatContextRetrieveResult(result);

      expect(formatted).toContain('Error retrieving context');
      expect(formatted).toContain('Test error');
    });

    it('should format empty result', async () => {
      const input: ContextRetrieveInput = { iteration: 999 };
      const result = await executeContextRetrieve(input, getSnapshot);

      const formatted = formatContextRetrieveResult(result);

      expect(formatted).toContain('No matching messages found');
    });

    it('should truncate long content in preview', async () => {
      const longHistory: LLMMessage[] = [
        {
          role: 'tool',
          content: 'x'.repeat(5000),
          iteration: 1,
        } as any,
      ];

      const getSnapshot = () => longHistory;
      const input: ContextRetrieveInput = { iteration: 1 };
      const result = await executeContextRetrieve(input, getSnapshot);

      const formatted = formatContextRetrieveResult(result);

      expect(formatted).toContain('4000 more chars'); // 5000 - 1000
    });

    it('should show tool name in formatted output', async () => {
      const input: ContextRetrieveInput = { tool_name: 'fs:read' };
      const result = await executeContextRetrieve(input, getSnapshot);

      const formatted = formatContextRetrieveResult(result);

      expect(formatted).toContain('Tool: fs:read');
    });
  });
});
