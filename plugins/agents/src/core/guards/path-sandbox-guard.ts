/**
 * PathSandboxGuard — enforces filesystem path restrictions on tool inputs.
 *
 * Checks path-like arguments (path, file, directory, dest, src, target)
 * against an allowlist. Any path outside the allowlist is rejected.
 *
 * Works with both absolute and relative paths — relative paths are resolved
 * against `cwd` at construction time.
 */

import * as nodePath from 'node:path';
import type { ToolGuard, ValidationResult, ToolExecCtx } from '../../sdk/index.js';

const PATH_ARG_KEYS = new Set([
  'path', 'file', 'filepath', 'filename',
  'directory', 'dir', 'folder',
  'dest', 'destination', 'src', 'source',
  'target', 'output', 'input',
]);

export interface PathSandboxOptions {
  /** Absolute paths that are allowed. Subdirectories are allowed automatically. */
  allowedPaths: string[];
  /** Working directory for resolving relative paths. Defaults to process.cwd(). */
  cwd?: string;
  /**
   * Names of tools that are exempted from path checking entirely.
   * Useful for read-only introspection tools that have their own access control.
   */
  exemptTools?: string[];
}

export class PathSandboxGuard implements ToolGuard {
  readonly name = 'path-sandbox';
  private readonly allowed: string[];
  private readonly cwd: string;
  private readonly exemptTools: Set<string>;

  constructor(options: PathSandboxOptions) {
    this.cwd = options.cwd ?? process.cwd();
    this.allowed = options.allowedPaths.map((p) => nodePath.resolve(p));
    this.exemptTools = new Set(options.exemptTools ?? []);
  }

  validateInput(
    toolName: string,
    input: Record<string, unknown>,
    _ctx: ToolExecCtx,
  ): ValidationResult {
    if (this.exemptTools.has(toolName)) {return { ok: true };}

    const paths = extractPathValues(input);
    for (const raw of paths) {
      const resolved = nodePath.resolve(this.cwd, raw);
      if (!this.isAllowed(resolved)) {
        return {
          ok: false,
          reason: `Path "${raw}" is outside allowed directories for tool "${toolName}"`,
          action: 'reject',
        };
      }
    }
    return { ok: true };
  }

  private isAllowed(resolved: string): boolean {
    return this.allowed.some(
      (allowed) => resolved === allowed || resolved.startsWith(allowed + nodePath.sep),
    );
  }
}

function extractPathValues(input: Record<string, unknown>): string[] {
  const results: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (PATH_ARG_KEYS.has(key.toLowerCase()) && typeof value === 'string') {
      results.push(value);
    }
  }
  return results;
}
