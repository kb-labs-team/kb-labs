/**
 * User interaction tools
 */

import * as readline from 'node:readline';
import type { Tool, ToolContext } from '../../types.js';

/**
 * Ask user a question (interactive mode only)
 */
export function createAskUserTool(_context: ToolContext): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'ask_user',
        description: 'Ask the user a question and wait for their response. Use when you need clarification or additional information. In non-interactive mode, returns a default answer.',
        parameters: {
          type: 'object',
          properties: {
            question: {
              type: 'string',
              description: 'Question to ask the user',
            },
          },
          required: ['question'],
        },
      },
    },
    executor: async (input: Record<string, unknown>) => {
      const question = input.question as string;

      // Check if running in interactive mode
      const isInteractive =
        process.stdin.isTTY && process.stdout.isTTY && !process.env.CI;

      if (!isInteractive) {
        // Non-interactive mode: return default answer
        return {
          success: true,
          output: `[Auto-answer] Question was: "${question}". Proceeding with default behavior.`,
        };
      }

      // Interactive mode: ask user
      return new Promise(resolve => {
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });

        rl.question(`\n❓ ${question}\n> `, answer => {
          rl.close();

          if (!answer || answer.trim() === '') {
            resolve({
              success: false,
              error: 'No answer provided',
            });
          } else {
            resolve({
              success: true,
              output: answer.trim(),
            });
          }
        });
      });
    },
  };
}
