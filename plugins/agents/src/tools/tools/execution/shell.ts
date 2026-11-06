/**
 * Shell execution tool
 */

import { execSync } from 'node:child_process';
import path from 'node:path';
import type { Tool, ToolContext } from '../../types.js';
import { toolError } from '../shared/tool-error.js';
import { SHELL_CONFIG } from '../../config.js';

const MAX_OUTPUT_CHARS = 8_000;

function trimOutput(output: string, label: 'stdout' | 'stderr'): string {
  if (output.length <= MAX_OUTPUT_CHARS) {return output;}
  const head = output.slice(0, MAX_OUTPUT_CHARS * 0.3);
  const tail = output.slice(-Math.floor(MAX_OUTPUT_CHARS * 0.7));
  return `${head}\n\n⚠️ ${label.toUpperCase()} TRIMMED (${output.length.toLocaleString()} chars, showing head+tail)\n💡 Pipe through grep/head/tail in your command to get focused output.\n\n...${tail}`;
}

/**
 * Execute shell command
 */
export function createShellExecTool(context: ToolContext): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'shell_exec',
        description: 'Execute a shell command and return output. Use for running builds, tests, git commands, etc. Commands run in the working directory.',
        parameters: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              description: 'Shell command to execute',
            },
            cwd: {
              type: 'string',
              description: 'Optional working directory relative to agent workingDir. Use to run command in a specific package/subdirectory.',
            },
          },
          required: ['command'],
        },
      },
    },
    executor: async (input: Record<string, unknown>) => {
      const command = input.command as string;
      const requestedCwd = typeof input.cwd === 'string' ? input.cwd.trim() : '';
      const resolvedCwd = requestedCwd
        ? path.resolve(context.workingDir, requestedCwd)
        : context.workingDir;

      const relative = path.relative(context.workingDir, resolvedCwd);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        return toolError({
          code: 'INVALID_CWD',
          message: `Invalid cwd "${requestedCwd}" - outside working directory.`,
          retryable: false,
          hint: 'Use cwd relative to the agent working directory.',
          details: { requestedCwd, resolvedCwd, workingDir: context.workingDir },
        });
      }

      try {
        const output = execSync(command, {
          cwd: resolvedCwd,
          encoding: 'utf-8',
          maxBuffer: SHELL_CONFIG.maxBuffer,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        const trimmed = trimOutput(output || '', 'stdout');
        return {
          success: true,
          output: `[cwd: ${resolvedCwd}]\n${trimmed || '(command completed with no output)'}`,
          metadata: {
            cwd: resolvedCwd,
            outputLength: output?.length ?? 0,
            trimmed: (output?.length ?? 0) > MAX_OUTPUT_CHARS,
          },
        };
      } catch (error: unknown) {
        // execSync throws when command exits with non-zero code
        const e = error as { stderr?: Buffer | string; stdout?: Buffer | string; status?: number; code?: string; signal?: string };
        const stderr = e.stderr?.toString() || '';
        const stdout = e.stdout?.toString() || '';
        const exitCode = e.status ?? -1;
        const commandText = typeof command === 'string' ? command.trim() : '';

        if (e.code === 'ETIMEDOUT' || e.signal === 'SIGTERM') {
          return toolError({
            code: 'SHELL_TIMEOUT',
            message: `Command timed out in ${resolvedCwd}`,
            retryable: true,
            hint: 'Use a narrower command or run package-scoped command via cwd.',
            details: { cwd: resolvedCwd, command: commandText, exitCode },
          });
        }

        if (/command not found/i.test(stderr) || exitCode === 127) {
          return toolError({
            code: 'COMMAND_NOT_FOUND',
            message: `Command not found: ${commandText}`,
            retryable: false,
            hint: 'Check binary name or ensure dependency is installed in this workspace.',
            details: { cwd: resolvedCwd, command: commandText, exitCode },
          });
        }

        if (/permission denied/i.test(stderr) || exitCode === 126) {
          return toolError({
            code: 'PERMISSION_DENIED',
            message: `Permission denied while executing command in ${resolvedCwd}`,
            retryable: false,
            hint: 'Check file permissions and executable bits.',
            details: { cwd: resolvedCwd, command: commandText, exitCode },
          });
        }

        const stdoutDisplay = trimOutput(stdout, 'stdout');
        const stderrDisplay = trimOutput(stderr, 'stderr');

        return toolError({
          code: 'NON_ZERO_EXIT',
          message: `Command failed with exit code ${exitCode}`,
          retryable: true,
          hint: 'Inspect stderr/stdout below. Pipe output through grep/head/tail to narrow it down.',
          details: {
            cwd: resolvedCwd,
            exitCode,
            stdout: stdoutDisplay || undefined,
            stderr: stderrDisplay || undefined,
          },
        });
      }
    },
  };
}
