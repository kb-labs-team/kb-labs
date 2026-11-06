/**
 * archive_recall tool - Retrieve full content from previously-read files
 * or tool outputs WITHOUT re-reading them.
 *
 * This is the agent's interface to Tier 2 (Cold Storage / ArchiveMemory).
 */

import type { ToolResult } from '../../../contracts/index.js';
import type { Tool, ToolContext } from '../../types.js';

export function createArchiveRecallTool(context: ToolContext): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'archive_recall',
        description:
          'Retrieve full content from previously-read files or tool outputs WITHOUT re-reading them. ' +
          'Use this to recall file contents, grep results, or any tool output from earlier iterations. ' +
          'Specify exactly one query mode: file_path, keyword, list_files, tool_name, or iteration.',
        parameters: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: 'Recall the last read of this file (full content)',
            },
            keyword: {
              type: 'string',
              description: 'Search across all archived outputs for this keyword',
            },
            list_files: {
              type: 'boolean',
              description: 'List all file paths that have been archived',
            },
            tool_name: {
              type: 'string',
              description: 'Recall recent outputs of a specific tool (e.g., grep_search)',
            },
            iteration: {
              type: 'number',
              description: 'Recall all tool outputs from a specific iteration number',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of results to return (default: 5)',
            },
          },
        },
      },
    },
    executor: async (input: Record<string, unknown>): Promise<ToolResult> => {
      const archive = context.archiveMemory;
      if (!archive) {
        return {
          success: false,
          error: 'Archive memory not available. This tool requires the two-tier memory system.',
        };
      }

      const limit = (input.limit as number) || 5;

      // Mode 1: Recall file content
      if (input.file_path) {
        const filePath = input.file_path as string;
        const entry = archive.recallByFilePath(filePath);
        if (!entry) {
          return {
            success: false,
            output: `File not found in archive: ${filePath}\n\nArchived files:\n${archive.getArchivedFilePaths().join('\n') || '(none)'}`,
          };
        }
        return {
          success: true,
          output: `[Archive] File: ${filePath} (read in iteration ${entry.iteration} via ${entry.toolName})\n\n${entry.fullOutput}`,
        };
      }

      // Mode 2: Keyword search
      if (input.keyword) {
        const keyword = input.keyword as string;
        const results = archive.search(keyword, limit);
        if (results.length === 0) {
          return {
            success: true,
            output: `No archived outputs contain "${keyword}"`,
          };
        }
        const formatted = results
          .map((r, i) => {
            const fileInfo = r.filePath ? ` (file: ${r.filePath})` : '';
            const preview = r.fullOutput.length > 500
              ? r.fullOutput.substring(0, 500) + `\n... (${r.fullOutput.length} chars total)`
              : r.fullOutput;
            return `--- Result ${i + 1}: ${r.toolName} @ iter ${r.iteration}${fileInfo} ---\n${preview}`;
          })
          .join('\n\n');
        return {
          success: true,
          output: `[Archive] Found ${results.length} result(s) for "${keyword}":\n\n${formatted}`,
        };
      }

      // Mode 3: List files
      if (input.list_files) {
        const files = archive.getArchivedFilePaths();
        if (files.length === 0) {
          return { success: true, output: 'No files archived yet.' };
        }
        return {
          success: true,
          output: `[Archive] ${files.length} file(s) archived:\n${files.join('\n')}`,
        };
      }

      // Mode 4: By tool name
      if (input.tool_name) {
        const toolName = input.tool_name as string;
        const results = archive.recallByToolName(toolName, limit);
        if (results.length === 0) {
          return {
            success: true,
            output: `No archived outputs for tool "${toolName}"`,
          };
        }
        const formatted = results
          .map((r, i) => {
            const fileInfo = r.filePath ? ` (file: ${r.filePath})` : '';
            const preview = r.fullOutput.length > 500
              ? r.fullOutput.substring(0, 500) + `\n... (${r.fullOutput.length} chars total)`
              : r.fullOutput;
            return `--- ${toolName} #${i + 1} @ iter ${r.iteration}${fileInfo} ---\n${preview}`;
          })
          .join('\n\n');
        return {
          success: true,
          output: `[Archive] ${results.length} output(s) from "${toolName}":\n\n${formatted}`,
        };
      }

      // Mode 5: By iteration
      if (input.iteration !== undefined) {
        const iteration = input.iteration as number;
        const results = archive.recallByIteration(iteration);
        if (results.length === 0) {
          return {
            success: true,
            output: `No archived outputs from iteration ${iteration}`,
          };
        }
        const formatted = results
          .map((r, i) => {
            const fileInfo = r.filePath ? ` (file: ${r.filePath})` : '';
            const preview = r.fullOutput.length > 500
              ? r.fullOutput.substring(0, 500) + `\n... (${r.fullOutput.length} chars total)`
              : r.fullOutput;
            return `--- ${r.toolName} #${i + 1}${fileInfo} ---\n${preview}`;
          })
          .join('\n\n');
        return {
          success: true,
          output: `[Archive] ${results.length} output(s) from iteration ${iteration}:\n\n${formatted}`,
        };
      }

      return {
        success: false,
        error: 'Specify at least one query parameter: file_path, keyword, list_files, tool_name, or iteration',
      };
    },
  };
}
