/**
 * RemoteWorkspaceProvider — proxies workspace operations to Workspace Agent via Gateway.
 *
 * Used when Agent Runner runs on Platform but needs to access files
 * on a remote Workspace Agent (Cursor-model: "brain" on server, "hands" on client).
 *
 * Uses Gateway dispatcher to send capability calls to connected Workspace Agent.
 *
 * @see ADR-0017: Workspace Agent Architecture (Phase 3)
 */

import type {
  IWorkspaceProvider,
  FileReadResult,
  FileStatResult,
  GrepResult,
  GlobResult,
  ShellResult,
} from './workspace-provider.js';

/** Gateway dispatcher call function (injected, avoids direct dependency on Gateway) */
export type DispatchFn = (
  adapter: string,
  method: string,
  args: unknown[],
) => Promise<unknown>;

export interface RemoteWorkspaceProviderOptions {
  /** Function to dispatch capability calls via Gateway */
  dispatch: DispatchFn;
}

export class RemoteWorkspaceProvider implements IWorkspaceProvider {
  constructor(private readonly opts: RemoteWorkspaceProviderOptions) {}

  async readFile(path: string, offset?: number, limit?: number): Promise<FileReadResult> {
    const result = await this.opts.dispatch('filesystem', 'readFile', [path]);
    const content = result as string;
    const lines = content.split('\n');

    const start = (offset ?? 1) - 1;
    const count = limit ?? lines.length;
    const sliced = lines.slice(start, start + count);

    return {
      content: sliced.join('\n'),
      totalLines: lines.length,
      truncated: sliced.length < lines.length,
    };
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.opts.dispatch('filesystem', 'writeFile', [path, content]);
  }

  async listDir(path: string, limit?: number): Promise<string[]> {
    const result = await this.opts.dispatch('filesystem', 'listDir', [path]);
    const entries = result as string[];
    return limit ? entries.slice(0, limit) : entries;
  }

  async stat(path: string): Promise<FileStatResult> {
    return await this.opts.dispatch('filesystem', 'stat', [path]) as FileStatResult;
  }

  async exists(path: string): Promise<boolean> {
    return await this.opts.dispatch('filesystem', 'exists', [path]) as boolean;
  }

  async grep(
    pattern: string,
    directory: string,
    options?: { includes?: string[]; excludes?: string[]; maxResults?: number; contextLines?: number },
  ): Promise<GrepResult> {
    return await this.opts.dispatch('search', 'grep', [pattern, directory, options]) as GrepResult;
  }

  async glob(
    pattern: string,
    directory: string,
    options?: { excludes?: string[]; maxResults?: number },
  ): Promise<GlobResult> {
    return await this.opts.dispatch('search', 'glob', [pattern, directory, options]) as GlobResult;
  }

  async shellExec(
    command: string,
    options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> },
  ): Promise<ShellResult> {
    return await this.opts.dispatch('shell', 'exec', [command, options]) as ShellResult;
  }
}
