/**
 * Search tools for finding files and content
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execa } from 'execa';
import type { Tool, ToolContext } from '../../types.js';
import { toolError } from '../shared/tool-error.js';
import { SEARCH_CONFIG, ALL_SOURCE_EXTENSIONS, toRgIncludesArgs, toFindNamesArgs } from '../../config.js';
import { normalizeOffsetLimit as _normalizeOffsetLimit, suggestDirectory } from '../../utils.js';

// ═══════════════════════════════════════════════════════════════════════════
// Output trimming
// ═══════════════════════════════════════════════════════════════════════════

function trimOutput(output: string, maxChars: number, continuationHint: string): string {
  if (output.length <= maxChars) {return output;}
  const trimmed = output.slice(0, maxChars);
  return `${trimmed}\n\n⚠️ OUTPUT TRIMMED (${output.length.toLocaleString()} chars → ${maxChars.toLocaleString()} shown)\n${continuationHint}`;
}

/** Default directories to exclude from search (sourced from centralized config) */
const DEFAULT_EXCLUDES = SEARCH_CONFIG.defaultExcludes;
const MAX_OUTPUT_CHARS = SEARCH_CONFIG.maxOutputChars;

/**
 * Build find exclude args from exclude list.
 * Returns flat triplets: ['!', '-path', '*\/node_modules\/*', '!', '-path', ...]
 */
function buildFindExcludes(excludes: readonly string[]): string[] {
  const args: string[] = [];
  for (const d of excludes) {
    args.push('!', '-path', `*/${d}/*`);
  }
  return args;
}

/**
 * Build grep exclude-dir args from exclude list.
 * Returns: ['--exclude-dir=node_modules', '--exclude-dir=dist', ...]
 */
function buildGrepExcludes(excludes: readonly string[]): string[] {
  return excludes.map(d => `--exclude-dir=${d}`);
}

const SEARCH_TIMEOUT_MS = SEARCH_CONFIG.timeoutMs;
const DEFAULT_RESULT_LIMIT = SEARCH_CONFIG.defaultResultLimit;
const MAX_RESULT_LIMIT = SEARCH_CONFIG.maxResultLimit;

/**
 * Check if directory exists and return error message if not.
 * Lists available top-level directories as a hint.
 */
function validateDirectory(workingDir: string, directory: string): string | null {
  const fullPath = path.resolve(workingDir, directory);
  if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
    return null;
  }

  // List available directories as hint
  let hint = '';
  try {
    const entries = fs.readdirSync(workingDir, { withFileTypes: true });
    const dirs = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map(e => e.name)
      .sort();
    if (dirs.length > 0) {
      hint = `\nAvailable directories: ${dirs.slice(0, 15).join(', ')}${dirs.length > 15 ? ` ... (${dirs.length} total)` : ''}`;
    }
  } catch { /* ignore */ }

  const suggestion = suggestDirectory(workingDir, directory);
  const didYouMean = suggestion ? `\nDid you mean: "${suggestion}"?` : '';
  return `Directory "${directory}" not found (resolved to ${fullPath}). Use "." to search from project root.${hint}${didYouMean}`;
}

function normalizeOffsetLimit(input: Record<string, unknown>): { offset: number; limit: number } {
  return _normalizeOffsetLimit(input, { defaultLimit: DEFAULT_RESULT_LIMIT, maxLimit: MAX_RESULT_LIMIT });
}

function paginate<T>(items: T[], offset: number, limit: number): { page: T[]; hasMore: boolean; nextOffset: number | null } {
  const page = items.slice(offset, offset + limit);
  const hasMore = offset + limit < items.length;
  return {
    page,
    hasMore,
    nextOffset: hasMore ? offset + limit : null,
  };
}

/**
 * Search for files by pattern (glob)
 */
export function createGlobSearchTool(context: ToolContext): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'glob_search',
        description: `Find files by name pattern (glob). Pattern matches filename only — use "*.ts" or "user.ts", not bare words. IMPORTANT: node_modules/, dist/, build/, .git/ are excluded by default — they contain no source code. Omit directory to search the entire working directory. Returns up to ${DEFAULT_RESULT_LIMIT} results.`,
        parameters: {
          type: 'object',
          properties: {
            pattern: {
              type: 'string',
              description: 'Glob pattern (e.g., "*.ts", "user.ts", "*user*.ts")',
            },
            directory: {
              type: 'string',
              description: 'Directory to search in (default: working directory root). Narrow to a subfolder when you already know the scope.',
            },
            exclude: {
              type: 'array',
              items: { type: 'string' },
              description: 'Extra directories to exclude on top of defaults (node_modules, dist, .git, build, .next, .kb, .pnpm, coverage are always excluded). Rarely needed.',
            },
            offset: {
              type: 'number',
              description: 'Result offset for pagination (default: 0)',
            },
            limit: {
              type: 'number',
              description: `Max results per page (default: ${DEFAULT_RESULT_LIMIT}, max: ${MAX_RESULT_LIMIT})`,
            },
          },
          required: ['pattern'],
        },
      },
    },
    executor: async (input: Record<string, unknown>) => {
      const pattern = input.pattern as string;
      const directory = (input.directory as string) || '.';
      const extra = input.exclude as string[] | undefined;
      const excludes = extra && extra.length > 0 ? [...new Set([...DEFAULT_EXCLUDES, ...extra])] : DEFAULT_EXCLUDES;
      const { offset, limit } = normalizeOffsetLimit(input);

      try {
        const fullPath = path.resolve(context.workingDir, directory);

        const dirError = validateDirectory(context.workingDir, directory);
        if (dirError) {
          return { success: true, output: dirError };
        }

        const windowSize = Math.min(2000, Math.max(500, offset + limit));

        const args = [
          fullPath,
          '-type', 'f',
          '-iname', pattern,
          ...buildFindExcludes(excludes),
        ];

        const result = await execa('find', args, {
          cwd: context.workingDir,
          reject: false,
          timeout: SEARCH_TIMEOUT_MS,
        });

        const files = result.stdout
          .split('\n')
          .filter(Boolean)
          .slice(0, windowSize)
          .map(f => path.relative(context.workingDir, f));

        if (files.length === 0) {
          return {
            success: true,
            output: `No files found matching pattern: ${pattern} in ${directory === '.' ? 'project root' : directory}. Note: glob_search matches filenames only. To search file contents, use grep_search. To find class/function definitions, use find_definition.`,
          };
        }

        const page = paginate(files, offset, limit);
        const excludeNote = `[Excluded: ${DEFAULT_EXCLUDES.join(', ')}${extra && extra.length > 0 ? ` + ${extra.join(', ')}` : ''}]`;
        const resultText = [
          `Found ${files.length} file(s) matching "${pattern}" in "${directory}" (showing ${page.page.length}, offset=${offset}, limit=${limit})`,
          excludeNote,
          '',
          ...page.page.map(f => `  ${f}`),
          page.hasMore ? '' : '',
        ].filter(s => s !== undefined).join('\n');

        const continuationHint = page.hasMore
          ? `Next page: glob_search(pattern="${pattern}", directory="${directory}", offset=${page.nextOffset}, limit=${limit})`
          : '';

        return {
          success: true,
          output: trimOutput(resultText, MAX_OUTPUT_CHARS, continuationHint),
          metadata: {
            totalMatches: files.length,
            offset,
            limit,
            hasMore: page.hasMore,
            nextOffset: page.nextOffset,
          },
        };
      } catch (error) {
        if (error instanceof Error && 'killed' in error && error.killed) {
          return toolError({
            code: 'SEARCH_TIMEOUT',
            message: `Glob search timed out after ${SEARCH_TIMEOUT_MS / 1000}s.`,
            retryable: true,
            hint: 'Narrow directory/pattern or lower limit.',
            details: { directory, pattern, timeoutMs: SEARCH_TIMEOUT_MS },
          });
        }
        if ((error as { code?: string }).code === 'ENOBUFS') {
          return toolError({
            code: 'SEARCH_BUFFER_OVERFLOW',
            message: 'Search output exceeded buffer.',
            retryable: true,
            hint: 'Narrow directory/pattern or reduce limit.',
            details: { directory, pattern, offset, limit },
          });
        }
        return toolError({
          code: 'SEARCH_FAILED',
          message: `Glob search failed: ${error instanceof Error ? error.message : String(error)}`,
          retryable: true,
          hint: 'Check pattern syntax and directory.',
          details: { directory, pattern },
        });
      }
    },
  };
}

/**
 * Search for text in files (grep)
 */
export function createGrepSearchTool(context: ToolContext): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'grep_search',
        description: `Search for text/regex in files. Returns file:line matches. IMPORTANT: node_modules/, dist/, build/ excluded by default. Omit directory to search the entire working directory. Add filePattern (e.g. "*.ts") to limit to specific file types. Returns up to ${DEFAULT_RESULT_LIMIT} matches.`,
        parameters: {
          type: 'object',
          properties: {
            pattern: {
              type: 'string',
              description: 'Text pattern to search for (can be regex)',
            },
            directory: {
              type: 'string',
              description: 'Directory to search in (default: working directory root). Narrow to a subfolder when you already know the scope.',
            },
            filePattern: {
              type: 'string',
              description: 'Filter by file extension (e.g., "*.ts", "*.md"). STRONGLY RECOMMENDED: always set this to avoid scanning binary/generated files.',
            },
            exclude: {
              type: 'array',
              items: { type: 'string' },
              description: 'Extra directories to exclude on top of defaults (node_modules, dist, .git, build, .next, .kb, .pnpm, coverage are always excluded). Rarely needed.',
            },
            mode: {
              type: 'string',
              enum: ['auto', 'regex', 'literal'],
              description: 'Search mode: auto (default), regex, or literal',
            },
            offset: {
              type: 'number',
              description: 'Result offset for pagination (default: 0)',
            },
            limit: {
              type: 'number',
              description: `Max matches per page (default: ${DEFAULT_RESULT_LIMIT}, max: ${MAX_RESULT_LIMIT})`,
            },
          },
          required: ['pattern'],
        },
      },
    },
    executor: async (input: Record<string, unknown>) => {
      const pattern = input.pattern as string;
      const directory = (input.directory as string) || '.';
      const filePattern = input.filePattern as string | undefined;
      const extra = input.exclude as string[] | undefined;
      const excludes = extra && extra.length > 0 ? [...new Set([...DEFAULT_EXCLUDES, ...extra])] : DEFAULT_EXCLUDES;
      const mode = ((input.mode as string) || 'auto').toLowerCase();
      const { offset, limit } = normalizeOffsetLimit(input);

      try {
        const fullPath = path.resolve(context.workingDir, directory);

        const dirError = validateDirectory(context.workingDir, directory);
        if (dirError) {
          return { success: true, output: dirError };
        }

        const windowSize = Math.min(2000, Math.max(500, offset + limit));

        const buildArgs = (literal: boolean): string[] => {
          const args: string[] = ['-rIn'];
          if (literal) {args.push('-F');}
          args.push(pattern, fullPath);
          args.push(...buildGrepExcludes(excludes));
          if (filePattern) {
            args.push(`--include=${filePattern}`);
          }
          return args;
        };

        let output = '';
        let usedLiteralFallback = false;

        const runGrep = async (literal: boolean): Promise<{ stdout: string; exitCode: number; stderr: string }> => {
          const res = await execa('grep', buildArgs(literal), {
            cwd: context.workingDir,
            reject: false,
            timeout: SEARCH_TIMEOUT_MS,
          });
          return { stdout: res.stdout, exitCode: res.exitCode ?? 0, stderr: res.stderr };
        };

        const initial = await runGrep(mode === 'literal');

        if (initial.exitCode === 2) {
          // exit code 2 = grep error (e.g. invalid regex)
          const looksLikeInvalidRegex = /(unbalanced|parentheses|invalid regular expression|regular expression)/i.test(initial.stderr);
          if (looksLikeInvalidRegex && mode !== 'regex') {
            // auto mode: fall back to literal
            usedLiteralFallback = true;
            const fallback = await runGrep(true);
            output = fallback.stdout;
            if (fallback.exitCode === 2) {
              return toolError({
                code: 'SEARCH_FAILED',
                message: `Grep search failed: ${fallback.stderr}`,
                retryable: true,
                hint: 'Try mode="literal" for special characters, or narrow directory.',
                details: { directory, pattern, filePattern, mode },
              });
            }
          } else {
            return toolError({
              code: 'SEARCH_FAILED',
              message: `Grep search failed: ${initial.stderr}`,
              retryable: true,
              hint: 'Try mode="literal" for special characters, or narrow directory.',
              details: { directory, pattern, filePattern, mode },
            });
          }
        } else {
          // exitCode 0 = matches found, exitCode 1 = no matches (grep convention)
          output = initial.stdout;
        }

        const lines = output.split('\n').filter(Boolean).slice(0, windowSize);

        if (lines.length === 0) {
          return {
            success: true,
            output: `No matches found for "${pattern}" in ${directory === '.' ? 'project root' : directory}.${filePattern ? '' : ' Try adding filePattern (e.g. "*.ts") to narrow the search.'}`,
          };
        }

        const page = paginate(lines, offset, limit);
        const excludeNote = `[Excluded: ${DEFAULT_EXCLUDES.join(', ')}${extra && extra.length > 0 ? ` + ${extra.join(', ')}` : ''}]`;
        const resultText = [
          `Found ${lines.length} match(es) for "${pattern}" in "${directory}"${filePattern ? ` (${filePattern})` : ''}${usedLiteralFallback ? ' (literal fallback)' : ''} (showing ${page.page.length}, offset=${offset}, limit=${limit})`,
          excludeNote,
          '',
          ...page.page.map(line => {
            const match = line.match(/^(.+?):(\d+):(.+)$/);
            if (match) {
              const [, filePath, lineNum, content] = match;
              const relPath = path.relative(context.workingDir, filePath!);
              return `  ${relPath}:${lineNum}\n    ${content!.trim()}`;
            }
            return `  ${line}`;
          }),
          page.hasMore ? '' : '',
        ].filter(s => s !== undefined).join('\n');

        const continuationHint = page.hasMore
          ? `Next page: grep_search(pattern="${pattern}", directory="${directory}", offset=${page.nextOffset}, limit=${limit})`
          : '';

        return {
          success: true,
          output: trimOutput(resultText, MAX_OUTPUT_CHARS, continuationHint),
          metadata: {
            totalMatches: lines.length,
            offset,
            limit,
            hasMore: page.hasMore,
            nextOffset: page.nextOffset,
            modeUsed: usedLiteralFallback ? 'literal' : mode === 'auto' ? 'regex' : mode,
          },
        };
      } catch (error) {
        if (error instanceof Error && 'killed' in error && (error as Error & { killed?: boolean }).killed) {
          return toolError({
            code: 'SEARCH_TIMEOUT',
            message: `Grep search timed out after ${SEARCH_TIMEOUT_MS / 1000}s.`,
            retryable: true,
            hint: 'Narrow directory, add filePattern, or lower limit.',
            details: { directory, pattern, timeoutMs: SEARCH_TIMEOUT_MS },
          });
        }
        if ((error as { code?: string }).code === 'ENOBUFS') {
          return toolError({
            code: 'SEARCH_BUFFER_OVERFLOW',
            message: 'Search output exceeded buffer.',
            retryable: true,
            hint: 'Narrow directory, add filePattern, or reduce limit.',
            details: { directory, pattern, filePattern, offset, limit, mode },
          });
        }

        return toolError({
          code: 'SEARCH_FAILED',
          message: `Grep search failed: ${error instanceof Error ? error.message : String(error)}`,
          retryable: true,
          hint: 'Try mode="literal" for special characters, or narrow directory.',
          details: { directory, pattern, filePattern, mode },
        });
      }
    },
  };
}

/**
 * List files in directory
 */
export function createListFilesTool(context: ToolContext): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'list_files',
        description: 'List files and directories at a path. Good for exploring what exists.',
        parameters: {
          type: 'object',
          properties: {
            directory: {
              type: 'string',
              description: 'Directory to list (default: "." for current directory)',
            },
            recursive: {
              type: 'boolean',
              description: 'Include subdirectories (default: false)',
            },
            offset: {
              type: 'number',
              description: 'Result offset for pagination (default: 0)',
            },
            limit: {
              type: 'number',
              description: `Max results per page (default: ${DEFAULT_RESULT_LIMIT}, max: ${MAX_RESULT_LIMIT})`,
            },
          },
        },
      },
    },
    executor: async (input: Record<string, unknown>) => {
      const directory = (input.directory as string) || '.';
      const recursive = (input.recursive as boolean) || false;
      const { offset, limit } = normalizeOffsetLimit(input);

      try {
        const fullPath = path.resolve(context.workingDir, directory);

        if (recursive) {
          const args = [
            fullPath,
            '-type', 'f',
            '!', '-path', '*/node_modules/*',
            '!', '-path', '*/.git/*',
            '!', '-path', '*/dist/*',
            '!', '-path', '*/.kb/*',
          ];

          const result = await execa('find', args, {
            cwd: context.workingDir,
            reject: false,
            timeout: SEARCH_TIMEOUT_MS,
          });

          const files = result.stdout
            .split('\n')
            .filter(Boolean)
            .slice(0, 100)
            .map(f => path.relative(context.workingDir, f));

          const page = paginate(files, offset, limit);
          return {
            success: true,
            output: files.length > 0
              ? `Files in ${directory} (recursive, showing ${page.page.length}/${files.length}, offset=${offset}, limit=${limit}):\n\n${page.page.map(f => `  ${f}`).join('\n')}${page.hasMore ? `\n\nNext page: list_files(directory="${directory}", recursive=true, offset=${page.nextOffset}, limit=${limit})` : ''}`
              : `No files found in ${directory}`,
            metadata: {
              totalMatches: files.length,
              offset,
              limit,
              hasMore: page.hasMore,
              nextOffset: page.nextOffset,
            },
          };
        }

        // Non-recursive: use fs.readdirSync to avoid shell entirely
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(fullPath, { withFileTypes: true });
        } catch {
          return {
            success: true,
            output: 'Directory not found',
          };
        }

        const lines = entries
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(e => {
            const indicator = e.isDirectory() ? '/' : e.isSymbolicLink() ? '@' : '';
            return `${e.name}${indicator}`;
          });

        return {
          success: true,
          output: `Contents of ${directory}:\n\n${lines.join('\n')}`,
        };
      } catch (error) {
        return {
          success: false,
          error: `List files failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}

/**
 * Find files containing specific code pattern (semantic search)
 * Language-agnostic - works with any programming language
 */
export function createFindDefinitionTool(context: ToolContext): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'find_definition',
        description: 'Find where a symbol (class, function, interface, type, etc.) is defined. Works with any language. Uses project root as default directory, which works well for monorepos with nested packages.',
        parameters: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Name of the symbol to find (class, function, interface, type, struct, etc.)',
            },
            directory: {
              type: 'string',
              description: 'Directory to search in (default: ".")',
            },
            filePattern: {
              type: 'string',
              description: 'File pattern to search (e.g., "*.cs" for C#, "*.py" for Python). If not specified, searches all source files.',
            },
          },
          required: ['name'],
        },
      },
    },
    executor: async (input: Record<string, unknown>) => {
      const name = input.name as string;
      const directory = (input.directory as string) || '.';
      const filePattern = input.filePattern as string | undefined;

      try {
        const fullPath = path.resolve(context.workingDir, directory);

        const dirError = validateDirectory(context.workingDir, directory);
        if (dirError) {
          return { success: true, output: dirError };
        }

        // Language-agnostic definition patterns
        const patterns = [
          // Common across languages
          `class ${name}`,
          `interface ${name}`,
          `struct ${name}`,
          `enum ${name}`,
          // TypeScript/JavaScript
          `function ${name}`,
          `const ${name}`,
          `let ${name}`,
          `var ${name}`,
          `type ${name}`,
          `export.*${name}`,
          // Python
          `def ${name}`,
          // C#/Java
          `public.*${name}`,
          `private.*${name}`,
          `protected.*${name}`,
          `static.*${name}`,
          // Go
          `func ${name}`,
          `func \\(.*\\) ${name}`,
          // Rust
          `fn ${name}`,
          `impl ${name}`,
          `trait ${name}`,
          `mod ${name}`,
        ];

        // Build include flags for grep
        let includeArgs: string[];
        if (filePattern) {
          includeArgs = [`--include=${filePattern}`];
        } else {
          // Default: search common source file extensions
          includeArgs = toRgIncludesArgs(ALL_SOURCE_EXTENSIONS);
        }

        const args = [
          '-rn', '-E',
          `(${patterns.join('|')})`,
          fullPath,
          ...includeArgs,
          ...buildGrepExcludes(DEFAULT_EXCLUDES),
          '--exclude-dir=bin',
          '--exclude-dir=obj',
          '--exclude-dir=target',
        ];

        const result = await execa('grep', args, {
          cwd: context.workingDir,
          reject: false,
          timeout: SEARCH_TIMEOUT_MS,
        });

        const lines = result.stdout.split('\n').filter(Boolean).slice(0, 30);

        if (lines.length === 0) {
          return {
            success: true,
            output: `No definition found for "${name}" in ${directory === '.' ? 'project root' : directory}. Try: grep_search for text matching, or glob_search with "*${name.toLowerCase()}*" for filename matching.`,
          };
        }

        const resultLines = lines.map(line => {
          const match = line.match(/^(.+?):(\d+):(.+)$/);
          if (match) {
            const [, filePath, lineNum, content] = match;
            const relPath = path.relative(context.workingDir, filePath!);
            return `${relPath}:${lineNum}\n  ${content!.trim()}`;
          }
          return line;
        });

        return {
          success: true,
          output: `Found definition(s) for "${name}":\n\n${resultLines.join('\n\n')}`,
        };
      } catch (error) {
        if (error instanceof Error && 'killed' in error && (error as Error & { killed?: boolean }).killed) {
          return {
            success: false,
            error: `Find definition timed out after ${SEARCH_TIMEOUT_MS / 1000}s. Try specifying a narrower directory.`,
          };
        }
        return {
          success: false,
          error: `Find definition failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}

/**
 * Get project structure overview — level-by-level exploration
 */
export function createProjectStructureTool(context: ToolContext): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'project_structure',
        description: 'Show directory contents at a given path. Defaults to project root, depth 1. Use to explore the codebase incrementally — first see top-level, then drill into specific directories.',
        parameters: {
          type: 'object',
          properties: {
            targetPath: {
              type: 'string',
              description: 'Directory to explore (default: project root). Use to drill deeper into a specific folder.',
            },
            depth: {
              type: 'number',
              description: 'How many levels deep (default: 1, max: 3)',
            },
          },
        },
      },
    },
    executor: async (input: Record<string, unknown>) => {
      const depth = Math.min((input.depth as number) || 1, 3);
      const targetPath = (input.targetPath as string) || '.';

      // Resolve and validate target path
      const resolvedPath = path.resolve(context.workingDir, targetPath);
      if (!resolvedPath.startsWith(context.workingDir)) {
        return {
          success: false,
          error: 'Cannot access paths outside project directory.',
        };
      }

      if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isDirectory()) {
        return {
          success: false,
          error: `"${targetPath}" is not a directory or does not exist.`,
        };
      }

      try {
        const skipNames = new Set(['node_modules', '.git', 'dist', '.next', 'build']);
        const lines: string[] = [];

        function listLevel(dir: string, prefix: string, currentDepth: number): void {
          let entries: fs.Dirent[];
          try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
          } catch {
            return;
          }

          // Separate dirs and files, sort each group
          const dirs = entries.filter(e => e.isDirectory() && !skipNames.has(e.name)).sort((a, b) => a.name.localeCompare(b.name));
          const files = entries.filter(e => e.isFile()).sort((a, b) => a.name.localeCompare(b.name));

          // Show directories with child counts
          for (const d of dirs) {
            const fullPath = path.join(dir, d.name);
            let childDirs = 0;
            let childFiles = 0;
            try {
              const children = fs.readdirSync(fullPath, { withFileTypes: true });
              childDirs = children.filter(c => c.isDirectory() && !skipNames.has(c.name)).length;
              childFiles = children.filter(c => c.isFile()).length;
            } catch {
              // inaccessible
            }
            const info = `${childDirs} dirs, ${childFiles} files`;
            lines.push(`${prefix}${d.name}/  (${info})`);

            if (currentDepth < depth) {
              listLevel(fullPath, prefix + '  ', currentDepth + 1);
            }
          }

          // Show files (only at requested depth, not intermediate levels for brevity)
          if (currentDepth === 1 || depth === 1) {
            for (const f of files) {
              lines.push(`${prefix}${f.name}`);
            }
          }
        }

        listLevel(resolvedPath, '', 1);

        const relPath = path.relative(context.workingDir, resolvedPath) || '.';
        const header = `${relPath}/ (depth ${depth})`;

        return {
          success: true,
          output: `${header}\n\n${lines.join('\n')}`,
        };
      } catch (error) {
        return {
          success: false,
          error: `Project structure failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}

/**
 * Count lines of code - language agnostic
 */
export function createCodeStatsTool(context: ToolContext): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'code_stats',
        description: 'Get line counts and file counts by extension for a directory scope (not single-file line counts).',
        parameters: {
          type: 'object',
          properties: {
            directory: {
              type: 'string',
              description: 'Directory to analyze (default: "."). If a file path is provided by mistake, use its parent directory.',
            },
            extensions: {
              type: 'string',
              description: 'Comma-separated list of extensions to count (e.g., "ts,tsx,js" or "cs,csproj" or "py"). If not specified, counts all source files.',
            },
            offset: {
              type: 'number',
              description: 'Offset for extension summary rows (default: 0)',
            },
            limit: {
              type: 'number',
              description: `Rows per page for extension summary (default: ${DEFAULT_RESULT_LIMIT}, max: ${MAX_RESULT_LIMIT})`,
            },
          },
        },
      },
    },
    executor: async (input: Record<string, unknown>) => {
      const directory = (input.directory as string) || '.';
      const extensionsInput = input.extensions as string | undefined;
      const { offset, limit } = normalizeOffsetLimit(input);

      try {
        const fullPath = path.resolve(context.workingDir, directory);

        const dirError = validateDirectory(context.workingDir, directory);
        if (dirError) {
          return { success: true, output: dirError };
        }

        // Build extension filter args
        let extFilterArgs: string[];
        if (extensionsInput) {
          const exts = extensionsInput.split(',').map(e => e.trim());
          extFilterArgs = toFindNamesArgs(exts);
        } else {
          extFilterArgs = toFindNamesArgs(ALL_SOURCE_EXTENSIONS);
        }

        const commonExcludes = [
          '!', '-path', '*/node_modules/*',
          '!', '-path', '*/dist/*',
          '!', '-path', '*/.git/*',
          '!', '-path', '*/bin/*',
          '!', '-path', '*/obj/*',
          '!', '-path', '*/target/*',
          '!', '-path', '*/__pycache__/*',
        ];

        // Find matching files (used as base for all three queries)
        const findArgs = [
          fullPath,
          '-type', 'f',
          '(',
          ...extFilterArgs,
          ')',
          ...commonExcludes,
        ];

        const findResult = await execa('find', findArgs, {
          cwd: context.workingDir,
          reject: false,
          timeout: SEARCH_TIMEOUT_MS,
        });

        const filePaths = findResult.stdout.split('\n').filter(Boolean);

        // Count total files
        const fileCount = filePaths.length;

        // Count by extension using JS
        const extCounts = new Map<string, number>();
        for (const fp of filePaths) {
          const ext = fp.includes('.') ? fp.split('.').pop()! : '(no ext)';
          extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
        }
        const countByExt = [...extCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 200)
          .map(([ext, count]) => `  ${count} ${ext}`);

        // Count total lines using wc -l on found files (batch call)
        let totalOutput = '0 total';
        if (filePaths.length > 0) {
          const wcResult = await execa('wc', ['-l', ...filePaths], {
            cwd: context.workingDir,
            reject: false,
          });
          // wc -l outputs a total line at the end when given multiple files
          const wcLines = wcResult.stdout.trim().split('\n').filter(Boolean);
          const lastLine = wcLines[wcLines.length - 1] ?? '';
          totalOutput = lastLine.trim();
        }

        const page = paginate(countByExt, offset, limit);
        return {
          success: true,
          output: `Code statistics for directory ${directory}:\n\nTotal lines: ${totalOutput}\nTotal files: ${fileCount}\n\nFiles by extension (showing ${page.page.length}/${countByExt.length}, offset=${offset}, limit=${limit}):\n${page.page.join('\n')}${page.hasMore ? `\n\nNext page: code_stats(directory="${directory}", offset=${page.nextOffset}, limit=${limit})` : ''}\n\nNote: This is directory-level aggregate. For a single file line count, use fs_read on that file and rely on metadata.totalLines.`,
          metadata: {
            totalExtensionRows: countByExt.length,
            offset,
            limit,
            hasMore: page.hasMore,
            nextOffset: page.nextOffset,
          },
        };
      } catch (error) {
        return toolError({
          code: 'CODE_STATS_FAILED',
          message: `Code stats failed: ${error instanceof Error ? error.message : String(error)}`,
          retryable: true,
          hint: 'Narrow directory or provide extensions.',
          details: { directory, extensions: extensionsInput },
        });
      }
    },
  };
}
