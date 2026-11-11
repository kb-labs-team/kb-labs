/**
 * @module @kb-labs/release/core/shell-adapter
 * Shell adapter for release-core - wraps execa with SDK types
 */

import { execa } from 'execa';
import type { ShellAPI, ExecResult, ExecOptions } from '@kb-labs/sdk';

/**
 * Create a ShellAPI adapter using execa
 * This is used in core libraries where ctx.runtime.shell is not available
 */
export function createExecaShellAdapter(): ShellAPI {
  return {
    async exec(command: string, args?: string[], options?: ExecOptions): Promise<ExecResult> {
      try {
        const result = await execa(command, args || [], {
          cwd: options?.cwd,
          timeout: options?.timeout,
          preferLocal: true,
          env: options?.env || process.env,
        });
        return {
          ok: result.exitCode === 0,
          code: result.exitCode ?? 0,
          stdout: result.stdout || '',
          stderr: result.stderr || '',
        };
      } catch (error: unknown) {
        const e = error as { exitCode?: number; stdout?: string; stderr?: string; message?: string };
        return {
          ok: false,
          code: e.exitCode || 1,
          stdout: e.stdout || '',
          stderr: e.stderr || e.message || '',
        };
      }
    },
  };
}

