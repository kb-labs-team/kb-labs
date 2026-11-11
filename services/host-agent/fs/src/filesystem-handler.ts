/**
 * FilesystemHandler — handles capability calls for adapter: 'filesystem'
 *
 * Supported methods:
 *   readFile(path)           → string (utf-8)
 *   writeFile(path, content) → void
 *   listDir(path)            → string[]
 *   stat(path)               → { size, isFile, isDir, mtime }
 *   exists(path)             → boolean
 *
 * Security: all paths are validated against allowedPaths allowlist.
 */

import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { resolve, normalize, sep, relative, join } from 'node:path';
import type { CapabilityCall } from '@kb-labs/host-agent-contracts';

/** A single file entry in a workspace snapshot */
export interface WorkspaceFile {
  path: string;    // relative path from workspace root
  content: string; // utf-8 content
}

/** Patterns always excluded from workspace fetch */
const FETCH_EXCLUDE = [
  'node_modules',
  '.git',
  'dist',
  '.kb/cache',
  '.kb/runtime',
  '.kb/logs',
];

export interface FilesystemHandlerOptions {
  /** Allowlisted root paths — requests outside these are rejected */
  allowedPaths: string[];
}

export class FilesystemHandler {
  constructor(private readonly opts: FilesystemHandlerOptions) {}

  async handle(call: CapabilityCall): Promise<unknown> {
    switch (call.method) {
      case 'readFile':       return this.readFile(this.argString(call.args, 0));
      case 'writeFile':      return this.writeFileMethod(this.argString(call.args, 0), this.argString(call.args, 1));
      case 'listDir':        return this.listDir(this.argString(call.args, 0));
      case 'stat':           return this.statMethod(this.argString(call.args, 0));
      case 'exists':         return this.exists(this.argString(call.args, 0));
      case 'fetchWorkspace': return this.fetchWorkspace(this.argString(call.args, 0));
      default:
        throw new Error(`Unknown filesystem method: ${call.method}`);
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
    // Append sep to prevent partial prefix match: /home/user2 starting with /home/user
    const allowed = this.opts.allowedPaths.some((p) => {
      const base = resolve(normalize(p));
      return resolved === base || resolved.startsWith(base + sep);
    });
    if (!allowed) { throw new Error(`Access denied: ${filePath}`); }
    return resolved;
  }

  private async readFile(filePath: string): Promise<string> {
    return readFile(this.validatePath(filePath), 'utf-8');
  }

  private async writeFileMethod(filePath: string, content: string): Promise<void> {
    await writeFile(this.validatePath(filePath), content, 'utf-8');
  }

  private async listDir(dirPath: string): Promise<string[]> {
    return readdir(this.validatePath(dirPath));
  }

  private async statMethod(filePath: string): Promise<{ size: number; isFile: boolean; isDir: boolean; mtime: number }> {
    const s = await stat(this.validatePath(filePath));
    return { size: s.size, isFile: s.isFile(), isDir: s.isDirectory(), mtime: s.mtimeMs };
  }

  private async exists(filePath: string): Promise<boolean> {
    try {
      await stat(this.validatePath(filePath));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Recursively collect all files under workspacePath and return them
   * as an array of { path, content } entries (utf-8 text files only).
   * Binary files are skipped. Excluded dirs (node_modules, .git, dist) are skipped.
   */
  private async fetchWorkspace(workspacePath: string): Promise<WorkspaceFile[]> {
    const root = this.validatePath(workspacePath);
    const files: WorkspaceFile[] = [];
    await this.collectFiles(root, root, files);
    return files;
  }

  private async collectFiles(root: string, dir: string, out: WorkspaceFile[]): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const relPath = relative(root, fullPath);

      // Skip excluded patterns (check each segment)
      if (FETCH_EXCLUDE.some((ex) => relPath === ex || relPath.startsWith(ex + sep) || entry === ex)) {
        continue;
      }

      let s: Awaited<ReturnType<typeof stat>>;
      try {
        s = await stat(fullPath);
      } catch {
        continue;
      }

      if (s.isDirectory()) {
        await this.collectFiles(root, fullPath, out);
      } else if (s.isFile() && s.size < 5 * 1024 * 1024) { // skip files > 5MB
        try {
          const content = await readFile(fullPath, 'utf-8');
          out.push({ path: relPath, content });
        } catch {
          // skip binary or unreadable files
        }
      }
    }
  }
}
