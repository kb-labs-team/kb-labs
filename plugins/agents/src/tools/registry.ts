/**
 * Tool registry for managing available tools
 */

import type { Tool, ToolContext } from './types.js';

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private context: ToolContext;

  constructor(context: ToolContext) {
    this.context = context;
  }

  /**
   * Register a tool
   */
  register(tool: Tool): void {
    this.tools.set(tool.definition.function.name, tool);
  }

  /**
   * Get tool by name
   */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /**
   * Get all tool definitions for LLM
   */
  getDefinitions() {
    return Array.from(this.tools.values()).map(t => t.definition);
  }

  /**
   * Execute a tool with automatic required-argument validation.
   * Returns a structured error if required args are missing/null/undefined,
   * so the agent understands what went wrong and can correct its call.
   */
  async execute(name: string, input: Record<string, unknown>) {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        success: false,
        output: `UNKNOWN_TOOL: "${name}" is not a registered tool. Available tools: ${this.getToolNames().join(', ')}`,
      };
    }

    // Validate required parameters against JSON schema
    const required: string[] = tool.definition.function.parameters?.required ?? [];
    const missing = required.filter(
      (key) => input[key] === undefined || input[key] === null,
    );
    if (missing.length > 0) {
      const params = tool.definition.function.parameters?.properties ?? {};
      const details = missing
        .map((k) => {
          const desc = (params[k] as { description?: string } | undefined)?.description ?? '';
          return `  - ${k}${desc ? ': ' + desc : ''}`;
        })
        .join('\n');
      return {
        success: false,
        output:
          `MISSING_REQUIRED_ARGUMENTS for tool "${name}":\n${details}\n\n` +
          `Hint: if a string argument is missing, your response may have been cut off by the output token limit (stop_reason=max_tokens). ` +
          `For large content, write in multiple smaller calls instead of one large call.`,
      };
    }

    return tool.executor(input);
  }

  /**
   * Get sorted list of registered tool names
   */
  getToolNames(): string[] {
    return Array.from(this.tools.keys()).sort();
  }

  /**
   * Get context
   */
  getContext(): ToolContext {
    return this.context;
  }
}
