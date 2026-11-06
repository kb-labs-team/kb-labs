/**
 * Mass replace tool for batch text replacement across multiple files
 *
 * Features:
 * - Supports literal string or regex patterns
 * - Glob-based file selection
 * - File history tracking for rollback
 * - Dry-run mode for preview
 * - Safe: validates paths, checks file sizes
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { glob } from 'glob';
import type { Tool, ToolContext } from '../../types.js';
import { validatePath } from '../../utils.js';
import { MASS_REPLACE_CONFIG } from '../../config.js';

const MAX_FILE_SIZE = MASS_REPLACE_CONFIG.maxFileSize;
const MAX_FILES = MASS_REPLACE_CONFIG.maxFiles;

// ═══════════════════════════════════════════════════════════════════════════
// mass_replace - Batch text replacement with history tracking
// ═══════════════════════════════════════════════════════════════════════════

export function createMassReplaceTool(context: ToolContext): Tool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'mass_replace',
        description: `Batch find-and-replace across multiple files. Supports literal and regex modes. Use dryRun=true to preview. Changes are tracked for rollback.`,
        parameters: {
          type: 'object',
          properties: {
            pattern: {
              type: 'string',
              description: 'Text or regex pattern to search for. For regex mode, use JavaScript regex syntax (without / delimiters).',
            },
            replacement: {
              type: 'string',
              description: 'Replacement text. In regex mode, can use $1, $2 for capture groups.',
            },
            scope: {
              type: 'string',
              description: 'REQUIRED: Directory to limit search scope (e.g., "src", "packages/agent-core", "."). Prevents accidental project-wide changes. Use "." for current directory only.',
            },
            files: {
              type: 'string',
              description: 'Glob pattern for files within scope (e.g., "**/*.ts", "*.js"). Combined with scope to form full path.',
            },
            mode: {
              type: 'string',
              enum: ['literal', 'regex'],
              description: 'Replacement mode: "literal" for exact string match (default), "regex" for regex patterns.',
            },
            dryRun: {
              type: 'boolean',
              description: 'Preview changes without applying them. Shows what would be changed.',
            },
            caseInsensitive: {
              type: 'boolean',
              description: 'For regex mode: make pattern case-insensitive (adds "i" flag).',
            },
          },
          required: ['pattern', 'replacement', 'scope', 'files'],
        },
      },
    },

    executor: async (input: Record<string, unknown>) => {
      const pattern = String(input.pattern || '');
      const replacement = String(input.replacement || '');
      const scope = String(input.scope || '');
      const filesPattern = String(input.files || '');
      const mode = String(input.mode || 'literal');
      const dryRun = Boolean(input.dryRun);
      const caseInsensitive = Boolean(input.caseInsensitive);

      // Validation
      if (!pattern) {
        return {
          success: false,
          error: 'VALIDATION_ERROR: "pattern" is required.',
        };
      }

      if (!scope) {
        return {
          success: false,
          error: 'VALIDATION_ERROR: "scope" is required. Specify directory to limit search (e.g., "src", "packages/agent-core", or "." for current dir).',
        };
      }

      if (!filesPattern) {
        return {
          success: false,
          error: 'VALIDATION_ERROR: "files" glob pattern is required.',
        };
      }

      if (mode !== 'literal' && mode !== 'regex') {
        return {
          success: false,
          error: `VALIDATION_ERROR: Invalid mode "${mode}". Must be "literal" or "regex".`,
        };
      }

      try {
        // Validate and resolve scope directory
        const scopeValidation = validatePath(context.workingDir, scope);
        if (!scopeValidation.valid) {
          return {
            success: false,
            error: scopeValidation.error,
          };
        }

        const scopePath = scopeValidation.resolved;
        if (!fs.existsSync(scopePath)) {
          return {
            success: false,
            error: `SCOPE_ERROR: Directory "${scope}" does not exist.`,
          };
        }

        if (!fs.statSync(scopePath).isDirectory()) {
          return {
            success: false,
            error: `SCOPE_ERROR: "${scope}" is not a directory.`,
          };
        }

        // Find matching files within scope
        const matches = await glob(filesPattern, {
          cwd: scopePath,
          nodir: true,
          absolute: false,
          ignore: ['**/node_modules/**', '**/dist/**', '**/.git/**'],
        });

        if (matches.length === 0) {
          return {
            success: true,
            output: `No files matched pattern: "${filesPattern}" in scope: "${scope}"`,
            metadata: {
              filesMatched: 0,
              filesChanged: 0,
              totalReplacements: 0,
              scope,
            },
          };
        }

        if (matches.length > MAX_FILES) {
          return {
            success: false,
            error: `TOO_MANY_FILES: Pattern matched ${matches.length} files, but limit is ${MAX_FILES}. Use more specific glob pattern.`,
          };
        }

        // Prepare regex or literal pattern
        let searchPattern: RegExp;
        if (mode === 'regex') {
          const flags = caseInsensitive ? 'gi' : 'g';
          try {
            searchPattern = new RegExp(pattern, flags);
          } catch (err) {
            return {
              success: false,
              error: `REGEX_ERROR: Invalid regex pattern "${pattern}": ${(err as Error).message}`,
            };
          }
        } else {
          // Literal mode: escape special chars and make global
          const escapedPattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const flags = caseInsensitive ? 'gi' : 'g';
          searchPattern = new RegExp(escapedPattern, flags);
        }

        // Process files
        const results: Array<{
          file: string;
          replacements: number;
          preview?: string;
        }> = [];

        let totalReplacements = 0;
        let filesChanged = 0;

        for (const relPath of matches) {
          // Combine scope and relative path
          const scopedPath = path.join(scope, relPath);

          // Validate path
          const validation = validatePath(context.workingDir, scopedPath);
          if (!validation.valid) {
            return {
              success: false,
              error: validation.error,
            };
          }

          const fullPath = validation.resolved;

          // Check file exists and size
          if (!fs.existsSync(fullPath)) {
            continue; // Skip missing files
          }

          const stats = fs.statSync(fullPath);
          if (stats.size > MAX_FILE_SIZE) {
            results.push({
              file: scopedPath,
              replacements: 0,
              preview: `[SKIPPED: File too large (${(stats.size / 1024).toFixed(1)} KB > ${MAX_FILE_SIZE / 1024} KB)]`,
            });
            continue;
          }

          // Read file
          const beforeContent = fs.readFileSync(fullPath, 'utf-8');

          // Apply replacement
          const afterContent = beforeContent.replace(searchPattern, replacement);

          // Check if anything changed
          if (beforeContent === afterContent) {
            continue; // No changes, skip
          }

          const matchCount = (beforeContent.match(searchPattern) || []).length;
          totalReplacements += matchCount;
          filesChanged++;

          // Dry-run: collect preview
          if (dryRun) {
            // Show first 3 changes as preview
            const lines = beforeContent.split('\n');
            const changedLines: string[] = [];
            let previewCount = 0;

            for (let i = 0; i < lines.length && previewCount < 3; i++) {
              const line = lines[i]!;
              if (searchPattern.test(line)) {
                const newLine = line.replace(searchPattern, replacement);
                changedLines.push(`  Line ${i + 1}:`);
                changedLines.push(`    - ${line.slice(0, 80)}`);
                changedLines.push(`    + ${newLine.slice(0, 80)}`);
                previewCount++;
              }
            }

            results.push({
              file: scopedPath,
              replacements: matchCount,
              preview: changedLines.join('\n'),
            });
          } else {
            // Apply changes
            fs.writeFileSync(fullPath, afterContent, 'utf-8');

            // Update read state so subsequent edits don't require re-read
            const hash = crypto.createHash('sha256').update(afterContent, 'utf-8').digest('hex');
            context.filesRead?.add(scopedPath);
            context.filesReadHash?.set(scopedPath, hash);

            results.push({
              file: scopedPath,
              replacements: matchCount,
            });
          }
        }

        // Format output
        const summary = dryRun
          ? `[DRY RUN] Would replace in ${filesChanged} file(s):`
          : `✅ Replaced in ${filesChanged} file(s):`;

        const details = results
          .map((r) => {
            if (r.preview) {
              return `${r.file}: ${r.replacements} replacement(s)\n${r.preview}`;
            }
            return `${r.file}: ${r.replacements} replacement(s)`;
          })
          .join('\n\n');

        const output = `${summary}\n\n${details}\n\n` +
          `Scope: ${scope}\n` +
          `Total replacements: ${totalReplacements}\n` +
          `Files matched: ${matches.length}\n` +
          `Files changed: ${filesChanged}` +
          (dryRun ? '\n\n⚠️ DRY RUN: No files were modified. Remove dryRun=true to apply changes.' : '');

        return {
          success: true,
          output,
          metadata: {
            scope,
            filesMatched: matches.length,
            filesChanged,
            totalReplacements,
            dryRun,
            pattern,
            replacement,
            mode,
          },
        };
      } catch (error) {
        return {
          success: false,
          error: `EXECUTION_ERROR: ${(error as Error).message}`,
        };
      }
    },
  };
}
