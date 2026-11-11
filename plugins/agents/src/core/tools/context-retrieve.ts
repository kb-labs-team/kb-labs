/**
 * context_retrieve - Tool for agents to retrieve full context when truncated
 *
 * Allows agents to request complete, non-truncated tool outputs or messages
 * from previous iterations when the default sliding window shows truncated data.
 */

import type { LLMMessage, LLMTool } from '@kb-labs/sdk';

/**
 * Extended message fields added at runtime by the agent (not part of the base LLMMessage type).
 * `iteration` — which agent iteration produced this message.
 * `tool_call_id` — OpenAI-style tool call id (snake_case variant of toolCallId).
 * `name` — tool name on tool-role messages.
 */
interface ExtendedLLMMessage extends LLMMessage {
  iteration?: number;
  tool_call_id?: string;
  name?: string;
}

export interface ContextRetrieveInput {
  /** Specific iteration number to retrieve (e.g., 5) */
  iteration?: number;
  /** Tool call ID to retrieve specific tool output */
  tool_call_id?: string;
  /** Topic/keyword to search (e.g., "package.json", "npm test") */
  topic?: string;
  /** Tool name to filter by (e.g., "fs:read", "mind:rag-query") */
  tool_name?: string;
}

export interface ContextRetrieveResult {
  success: boolean;
  messages: LLMMessage[];
  count: number;
  error?: string;
}

/**
 * Create context_retrieve tool definition
 * Returns LLMTool format (KB Labs internal format, not OpenAI format)
 */
export function createContextRetrieveTool(
  _getHistorySnapshot: () => ReadonlyArray<Readonly<LLMMessage>>
): LLMTool {
  return {
    name: 'context_retrieve',
    description: `Retrieve full, non-truncated context from previous iterations.

Use when:
- You see "use context_retrieve to expand" in truncated tool outputs
- You need complete file contents that were truncated
- You want to review specific past tool calls or iterations

Returns: Full messages with complete (non-truncated) content.`,
    inputSchema: {
      type: 'object',
      properties: {
        iteration: {
          type: 'number',
          description: 'Specific iteration number to retrieve (e.g., 5 for iteration 5)',
        },
        tool_call_id: {
          type: 'string',
          description: 'Specific tool call ID to retrieve (from truncated message)',
        },
        topic: {
          type: 'string',
          description: 'Search keyword/topic (e.g., "package.json", "npm test", "authentication")',
        },
        tool_name: {
          type: 'string',
          description: 'Filter by tool name (e.g., "fs:read", "mind:rag-query", "shell:exec")',
        },
      },
      // No required parameters - at least one should be provided
    },
  };
}

/**
 * Execute context_retrieve tool
 */
export async function executeContextRetrieve(
  input: ContextRetrieveInput,
  getHistorySnapshot: () => ReadonlyArray<Readonly<LLMMessage>>
): Promise<ContextRetrieveResult> {
  const snapshot = getHistorySnapshot();

  // Validate input
  if (!input.iteration && !input.tool_call_id && !input.topic && !input.tool_name) {
    return {
      success: false,
      messages: [],
      count: 0,
      error: 'At least one filter (iteration, tool_call_id, topic, or tool_name) must be provided',
    };
  }

  // Filter messages
  let filtered = [...snapshot];

  // Filter by iteration
  if (input.iteration !== undefined) {
    filtered = filtered.filter((msg) => {
      const iter = (msg as ExtendedLLMMessage).iteration;
      return iter === input.iteration;
    });
  }

  // Filter by tool_call_id
  if (input.tool_call_id) {
    filtered = filtered.filter((msg) => {
      const toolCallId = (msg as ExtendedLLMMessage).tool_call_id;
      return toolCallId === input.tool_call_id;
    });
  }

  // Filter by tool_name
  if (input.tool_name) {
    filtered = filtered.filter((msg) => {
      if (msg.role !== 'tool') {return false;}
      const name = (msg as ExtendedLLMMessage).name;
      return name === input.tool_name;
    });
  }

  // Filter by topic (search in content)
  if (input.topic) {
    filtered = filtered.filter((msg) => {
      const content = msg.content || '';
      return content.toLowerCase().includes(input.topic!.toLowerCase());
    });
  }

  // Remove truncation metadata (return full content)
  const fullMessages = filtered.map((msg) => {
    const copy = { ...msg };
    if (copy.metadata) {
      const meta = copy.metadata as { truncated?: unknown; originalLength?: unknown };
      delete meta.truncated;
      delete meta.originalLength;
    }
    return copy;
  });

  return {
    success: true,
    messages: fullMessages,
    count: fullMessages.length,
  };
}

/**
 * Format context_retrieve result for agent
 */
export function formatContextRetrieveResult(result: ContextRetrieveResult): string {
  if (!result.success) {
    return `Error retrieving context: ${result.error}`;
  }

  if (result.count === 0) {
    return 'No matching messages found. Try different filters.';
  }

  const lines: string[] = [
    `Found ${result.count} message(s):`,
    '',
  ];

  for (let i = 0; i < result.messages.length; i++) {
    const msg = result.messages[i]!; // Array access is safe within length bounds
    const iter = (msg as ExtendedLLMMessage).iteration || '?';
    const role = msg.role;

    lines.push(`[${i + 1}] Iteration ${iter} - ${role}`);

    if (msg.role === 'tool') {
      const toolName = (msg as ExtendedLLMMessage).name || 'unknown';
      lines.push(`  Tool: ${toolName}`);
    }

    const content = msg.content || '';
    const preview = content.length > 1000 ? `${content.slice(0, 1000)}\n...(${content.length - 1000} more chars)` : content;

    lines.push(`  Content: ${preview}`);
    lines.push('');
  }

  return lines.join('\n');
}
