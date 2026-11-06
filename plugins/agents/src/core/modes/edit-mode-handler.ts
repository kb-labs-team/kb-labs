/**
 * Edit mode handler - modify existing files
 */

import type { TaskResult, AgentConfig, EditContext } from '../../contracts/index.js';
import type { ToolRegistry } from '../../tools/index.js';
import type { ModeHandler } from './mode-handler';
import { AgentSDK } from '../../sdk/index.js';
import { createCoreToolPack } from '../tools/index.js';

/**
 * Edit mode - focus on modifying existing files
 */
export class EditModeHandler implements ModeHandler {
  async execute(
    task: string,
    config: AgentConfig,
    toolRegistry: ToolRegistry
  ): Promise<TaskResult> {
    const editContext = config.mode?.context as EditContext | undefined;
    const targetFiles = editContext?.targetFiles || [];
    const dryRun = editContext?.dryRun || false;

    // Enhanced task prompt for edit mode
    let enhancedTask = task;

    if (targetFiles.length > 0) {
      enhancedTask += `\n\nTarget files to edit:\n${targetFiles.map((f) => `- ${f}`).join('\n')}`;
      enhancedTask += '\n\nFocus on reading these files first, then applying necessary edits.';
    }

    if (dryRun) {
      enhancedTask += '\n\nDRY RUN MODE: Preview changes but DO NOT write to files. Describe what changes would be made.';
    }

    enhancedTask += '\n\nPrefer editing existing files over creating new ones.';

    // Execute with SDK agent
    const runner = new AgentSDK()
      .register(createCoreToolPack(toolRegistry))
      .createRunner(config);
    const result = await runner.execute(enhancedTask);

    // Add edit mode context to result
    return {
      ...result,
      summary: dryRun
        ? `[DRY RUN] ${result.summary}`
        : result.summary,
    };
  }
}
