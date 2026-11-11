/**
 * IWorkspaceProvider — abstraction for workspace operations.
 *
 * When agent runs on Platform but workspace is on Workspace Agent,
 * this interface proxies fs/search/git/shell operations through Gateway.
 *
 * When agent runs locally (same machine as workspace), LocalWorkspaceProvider
 * delegates to native fs/child_process (current behavior).
 *
 * Tools check `context.workspaceProvider`:
 * - If set → use provider methods (remote or local)
 * - If not set → use native fs directly (backwards compatible)
 *
 * @see ADR-0017: Workspace Agent Architecture (Phase 3)
 */

export interface FileReadResult {
  content: string;
  totalLines: number;
  truncated: boolean;
}

export interface FileStatResult {
  size: number;
  isFile: boolean;
  isDir: boolean;
  mtime: number;
}

export interface GrepMatch {
  file: string;
  line: number;
  content: string;
}

export interface GrepResult {
  matches: GrepMatch[];
  truncated: boolean;
  totalMatches: number;
}

export interface GlobResult {
  files: string[];
  truncated: boolean;
  totalFiles: number;
}

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface IWorkspaceProvider {
  /** Read file content with offset/limit */
  readFile(path: string, offset?: number, limit?: number): Promise<FileReadResult>;

  /** Write file content */
  writeFile(path: string, content: string): Promise<void>;

  /** List directory contents */
  listDir(path: string, limit?: number): Promise<string[]>;

  /** Get file/dir stats */
  stat(path: string): Promise<FileStatResult>;

  /** Check if path exists */
  exists(path: string): Promise<boolean>;

  /** Search file contents (grep) */
  grep(pattern: string, directory: string, options?: {
    includes?: string[];
    excludes?: string[];
    maxResults?: number;
    contextLines?: number;
  }): Promise<GrepResult>;

  /** Find files by glob pattern */
  glob(pattern: string, directory: string, options?: {
    excludes?: string[];
    maxResults?: number;
  }): Promise<GlobResult>;

  /** Execute shell command */
  shellExec(command: string, options?: {
    cwd?: string;
    timeoutMs?: number;
    env?: Record<string, string>;
  }): Promise<ShellResult>;
}
