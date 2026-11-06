/**
 * Debug mode handler - analyze errors with trace context
 */

import type { TaskResult, AgentConfig, DebugContext } from '../../contracts/index.js';
import type { ToolRegistry } from '../../tools/index.js';
import type { ModeHandler } from './mode-handler';
import { AgentSDK } from '../../sdk/index.js';
import { createCoreToolPack } from '../tools/index.js';
import { promises as fs } from 'node:fs';

/**
 * Debug mode - analyze errors and suggest fixes with trace context
 */
export class DebugModeHandler implements ModeHandler {
  async execute(
    task: string,
    config: AgentConfig,
    toolRegistry: ToolRegistry
  ): Promise<TaskResult> {
    const debugContext = config.mode?.context as DebugContext | undefined;
    const traceFile = debugContext?.traceFile;
    const errorTrace = debugContext?.errorTrace;
    const relevantFiles = debugContext?.relevantFiles || [];

    // Enhanced task prompt for debug mode
    let enhancedTask = `DEBUG MODE: ${task}\n\n`;

    // Load trace file if provided
    if (traceFile) {
      try {
        const traceContent = await fs.readFile(traceFile, 'utf-8');
        const trace = JSON.parse(traceContent);

        enhancedTask += '## Execution Trace\n\n';
        enhancedTask += '```json\n';
        enhancedTask += JSON.stringify(trace, null, 2);
        enhancedTask += '\n```\n\n';
      } catch {
        enhancedTask += `⚠️ Failed to load trace file: ${traceFile}\n\n`;
      }
    }

    // Add error trace if provided
    if (errorTrace) {
      enhancedTask += '## Error Trace\n\n';
      enhancedTask += '```\n';
      enhancedTask += errorTrace;
      enhancedTask += '\n```\n\n';
    }

    // Add relevant files if provided
    if (relevantFiles.length > 0) {
      enhancedTask += '## Relevant Files\n\n';
      enhancedTask += relevantFiles.map((f) => `- ${f}`).join('\n');
      enhancedTask += '\n\n';
      enhancedTask += 'Read these files to understand the context.\n\n';
    }

    enhancedTask += '## Your Task\n\n';
    enhancedTask += '1. Analyze the trace and error information\n';
    enhancedTask += '2. Identify the root cause\n';
    enhancedTask += '3. Suggest or implement fixes\n';
    enhancedTask += '4. Explain what went wrong and why the fix works\n';

    // Execute with SDK agent
    const runner = new AgentSDK()
      .register(createCoreToolPack(toolRegistry))
      .createRunner(config);
    const result = await runner.execute(enhancedTask);

    return {
      ...result,
      summary: `[DEBUG] ${result.summary}`,
    };
  }
}
