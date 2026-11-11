/**
 * ShellHandler — handles capability calls for adapter: 'shell'
 *
 * Supported methods:
 *   exec(command, options?)  → ShellResult
 *
 * Security:
 * - Paths validated against allowedPaths
 * - Dangerous commands blocked (rm -rf /, fork bombs, etc.)
 * - Timeout enforcement
 *
 * @see ADR-0017: Workspace Agent Architecture (Phase 3)
 */

import { execSync } from 'node:child_process';
import { resolve, normalize, sep } from 'node:path';
import type { CapabilityCall } from '@kb-labs/host-agent-contracts';

interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface ShellOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 10 * 1024 * 1024; // 10MB

/** Commands that are always blocked */
const BLOCKED_COMMANDS = [
  /rm\s+-rf\s+\//,
  /rm\s+-rf\s+\/\*/,
  /mkfs/,
  /dd\s+if=/,
  /:.*\(\)\s*\{\s*:\s*\|.*&\s*\}\s*;/,  // fork bomb
  /chmod\s+-R\s+777\s+\//,
  /chown\s+-R/,
  />\s*\/dev\/sda/,
  /mv\s+\/\*/,
];

export interface ShellHandlerOptions {
  allowedPaths: string[];
}

export class ShellHandler {
  constructor(private readonly opts: ShellHandlerOptions) {}

  async handle(call: CapabilityCall): Promise<unknown> {
    switch (call.method) {
      case 'exec':
        return this.exec(
          this.argString(call.args, 0),
          (call.args[1] as ShellOptions) ?? {},
        );
      default:
        throw new Error(`Unknown shell method: ${call.method}`);
    }
  }

  private argString(args: unknown[], index: number): string {
    const val = args[index];
    if (typeof val !== 'string' || val.length === 0) {
      throw new Error(`Expected non-empty string at args[${index}]`);
    }
    return val;
  }

  private validatePath(filePath: string): string {
    const resolved = resolve(normalize(filePath));
    const allowed = this.opts.allowedPaths.some((p) => {
      const base = resolve(normalize(p));
      return resolved === base || resolved.startsWith(base + sep);
    });
    if (!allowed) { throw new Error(`Access denied: ${filePath}`); }
    return resolved;
  }

  private exec(command: string, options: ShellOptions): ShellResult {
    // 1. Check for blocked commands
    for (const pattern of BLOCKED_COMMANDS) {
      if (pattern.test(command)) {
        throw new Error(`Blocked command: ${command}`);
      }
    }

    // 2. Resolve and validate cwd
    const cwd = options.cwd
      ? this.validatePath(options.cwd)
      : this.opts.allowedPaths[0]
        ? resolve(normalize(this.opts.allowedPaths[0]))
        : process.cwd();

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // 3. Execute
    try {
      const stdout = execSync(command, {
        cwd,
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: options.env ? { ...process.env, ...options.env } : undefined,
      });

      return { stdout: stdout ?? '', stderr: '', exitCode: 0 };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; message?: string; status?: number };
      return {
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? e.message ?? '',
        exitCode: e.status ?? 1,
      };
    }
  }
}
