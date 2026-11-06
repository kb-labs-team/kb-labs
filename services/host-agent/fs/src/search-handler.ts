/**
 * SearchHandler — handles capability calls for adapter: 'search'
 *
 * Supported methods:
 *   grep(pattern, directory, options?)  → GrepResult
 *   glob(pattern, directory, options?)  → GlobResult
 *
 * Security: all paths are validated against allowedPaths allowlist.
 *
 * @see ADR-0017: Workspace Agent Architecture (Phase 3)
 */

import { spawnSync } from 'node:child_process';
import { resolve, normalize, sep } from 'node:path';
import type { CapabilityCall } from '@kb-labs/host-agent-contracts';

interface GrepMatch {
  file: string;
  line: number;
  content: string;
}

interface GrepResult {
  matches: GrepMatch[];
  truncated: boolean;
  totalMatches: number;
}

interface GlobResult {
  files: string[];
  truncated: boolean;
  totalFiles: number;
}

interface GrepOptions {
  includes?: string[];
  excludes?: string[];
  maxResults?: number;
  contextLines?: number;
}

interface GlobOptions {
  excludes?: string[];
  maxResults?: number;
}

const DEFAULT_EXCLUDES = ['node_modules', '.git', 'dist', '.next', '.kb/cache', '.kb/runtime'];
const DEFAULT_MAX_RESULTS = 100;
const SEARCH_TIMEOUT_MS = 15_000;
const SEARCH_MAX_BUFFER = 5 * 1024 * 1024; // 5MB

export interface SearchHandlerOptions {
  allowedPaths: string[];
}

export class SearchHandler {
  constructor(private readonly opts: SearchHandlerOptions) {}

  async handle(call: CapabilityCall): Promise<unknown> {
    switch (call.method) {
      case 'grep':
        return this.grep(
          this.argString(call.args, 0),
          this.argString(call.args, 1),
          (call.args[2] as GrepOptions) ?? {},
        );
      case 'glob':
        return this.glob(
          this.argString(call.args, 0),
          this.argString(call.args, 1),
          (call.args[2] as GlobOptions) ?? {},
        );
      default:
        throw new Error(`Unknown search method: ${call.method}`);
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

  private grep(pattern: string, directory: string, options: GrepOptions): GrepResult {
    const dir = this.validatePath(directory);
    const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
    const excludes = options.excludes ?? DEFAULT_EXCLUDES;

    let cmd: string;
    let args: string[];

    if (this.hasRipgrep()) {
      cmd = 'rg';
      args = ['--no-heading', '--line-number', `--max-count=${maxResults}`];
      for (const d of excludes) { args.push(`--glob=!${d}`); }
      if (options.includes) {
        for (const ext of options.includes) { args.push(`--glob=${ext}`); }
      }
      if (options.contextLines) { args.push('-C', String(options.contextLines)); }
      args.push('--', pattern, dir);
    } else {
      cmd = 'grep';
      args = ['-rn'];
      for (const d of excludes) { args.push(`--exclude-dir=${d}`); }
      if (options.includes) {
        for (const ext of options.includes) { args.push(`--include=${ext}`); }
      }
      if (options.contextLines) { args.push(`-C${options.contextLines}`); }
      args.push('-m', String(maxResults), '--', pattern, dir);
    }

    const result = spawnSync(cmd, args, {
      timeout: SEARCH_TIMEOUT_MS,
      maxBuffer: SEARCH_MAX_BUFFER,
      encoding: 'utf-8',
    });

    // exit 1 = no matches (grep/rg convention)
    if (result.status !== 0 && result.status !== 1) {
      return { matches: [], truncated: false, totalMatches: 0 };
    }

    const lines = (result.stdout ?? '').trim().split('\n').filter(Boolean);
    const matches: GrepMatch[] = [];

    for (const line of lines) {
      const match = line.match(/^(.+?):(\d+):(.*)$/);
      if (match) {
        matches.push({
          file: match[1]!,
          line: parseInt(match[2]!, 10),
          content: match[3]!,
        });
      }
    }

    return {
      matches: matches.slice(0, maxResults),
      truncated: matches.length >= maxResults,
      totalMatches: matches.length,
    };
  }

  private glob(pattern: string, directory: string, options: GlobOptions): GlobResult {
    const dir = this.validatePath(directory);
    const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
    const excludes = options.excludes ?? DEFAULT_EXCLUDES;

    const args = [dir, '-type', 'f', '-name', pattern];
    for (const d of excludes) { args.push('!', '-path', `*/${d}/*`); }

    const result = spawnSync('find', args, {
      timeout: SEARCH_TIMEOUT_MS,
      maxBuffer: SEARCH_MAX_BUFFER,
      encoding: 'utf-8',
    });

    const files = (result.stdout ?? '').trim().split('\n').filter(Boolean);
    const truncated = files.length > maxResults;

    return {
      files: files.slice(0, maxResults),
      truncated,
      totalFiles: files.length,
    };
  }

  private hasRipgrep(): boolean {
    const result = spawnSync('rg', ['--version'], { stdio: 'pipe', timeout: 2000 });
    return result.status === 0;
  }
}
