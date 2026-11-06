/** Governed ShellAPI facade. Native spawning belongs to IProcessExecutor. */

import { basename } from 'node:path';
import { createErrorEnvelope, ErrorEnvelopeError } from '@kb-labs/core-platform';
import type { ShellAPI, ExecResult, ExecOptions, PermissionSpec } from '@kb-labs/plugin-contracts';
import { matchesPermissionPattern, PermissionError } from '@kb-labs/plugin-contracts';
import type { IProcessExecutor, ProcessExecutionIdentity, ProcessResult } from '@kb-labs/core-platform/adapters';
import { GovernedProcessError } from '../process/errors.js';

const BLOCKED_COMMANDS = [
  'rm -rf /', 'rm -rf /*', 'mkfs', 'dd if=', ':(){:|:&};:',
  'chmod -R 777 /', 'chown -R', '> /dev/sda', 'mv /* ',
];

export interface CreateShellAPIOptions {
  pluginId: string;
  permissions: PermissionSpec;
  cwd: string;
  processExecutor?: IProcessExecutor;
  processIdentity?: ProcessExecutionIdentity;
  signal?: AbortSignal;
}

function processError(error: unknown): Error {
  if (error instanceof Error) { return error; }
  return new Error(String(error));
}

export function createShellAPI(options: CreateShellAPIOptions): ShellAPI {
  const { permissions, cwd, pluginId } = options;
  const allowedCommands = permissions.shell?.allow ?? [];
  const identity = options.processIdentity ?? {
    executionId: 'unknown-execution', requestId: 'unknown-request', pluginId,
  };
  const permissionDetails = { plugin: pluginId, permission: 'shell.exec' };
  if (allowedCommands.length === 0) {
    return { async exec(): Promise<never> { throw new PermissionError('Shell execution not allowed', permissionDetails); } };
  }

  const executor = options.processExecutor;
  if (!executor) {
    throw new Error('Governed process executor is unavailable in this execution host');
  }
  const quotas = permissions.quotas ?? {};

  return {
    async exec(command: string, args: string[] = [], execOptions?: ExecOptions): Promise<ExecResult> {
      const fullCommand = `${command} ${args.join(' ')}`;
      for (const blocked of BLOCKED_COMMANDS) {
        if (fullCommand.includes(blocked)) {
          throw new PermissionError('Dangerous command blocked', permissionDetails);
        }
      }
      if (!allowedCommands.some((pattern) => matchesPermissionPattern(command, pattern) || matchesPermissionPattern(basename(command), pattern))) {
        throw new PermissionError('Command not in whitelist', permissionDetails);
      }

      const requestedTimeout = execOptions?.timeout ?? quotas.timeoutMs ?? 30_000;
      const timeoutMs = Math.min(requestedTimeout, quotas.timeoutMs ?? requestedTimeout);
      const processCwd = execOptions?.cwd ?? cwd;
      let result: ProcessResult;
      try {
        result = await executor.execute({
          identity,
          command,
          args,
          cwd: processCwd,
          env: execOptions?.env,
          signal: execOptions?.signal ?? options.signal,
          retry: execOptions?.retry,
          limits: {
            timeoutMs,
            cpuMs: quotas.cpuMs,
            memoryMb: quotas.memoryMb,
            maxProcesses: quotas.maxProcesses,
            maxConcurrent: permissions.shell?.maxConcurrent,
            maxOutputBytes: execOptions?.maxOutputBytes ?? quotas.maxOutputBytes,
          },
        });
      } catch (error) {
        if (error instanceof GovernedProcessError && error.limit) {
          throw new ErrorEnvelopeError(createErrorEnvelope('KB_RUNTIME_PROCESS_LIMIT_EXCEEDED', {
            details: {
              allowed: String(error.limit.allowed),
              cwd: processCwd,
              observed: String(error.limit.observed),
              process: [command, ...args].join(' '),
              resource: error.limit.resource,
            },
          }));
        }
        throw error;
      }
      const output: ExecResult = {
        code: result.code ?? -1,
        stdout: result.stdout,
        stderr: result.stderr,
        ok: result.ok,
        processId: result.processId,
        terminationReason: result.terminationReason,
        usage: result.usage,
        attempts: result.attempts,
      };
      if (execOptions?.throwOnError && !output.ok) {
        const error = new Error(`Command failed with code ${output.code}: ${output.stderr}`);
        Object.assign(error, { code: 'PROCESS_EXIT_NON_ZERO', result: output });
        throw error;
      }
      return output;
    },
  };
}

export function normalizeShellError(error: unknown): Error {
  return processError(error);
}
