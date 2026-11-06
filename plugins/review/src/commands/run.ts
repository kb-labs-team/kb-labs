/**
 * review:run command
 * Run code review analysis
 */

import {
  defineCommand,
  useLoader,
  useConfig,
  validationError,
  handleError,
  type PluginCommandContextV3,
  type CLIInput,
  type CommandResult,
} from '@kb-labs/sdk';
import type { ReviewMode, ReviewResult, InputFile } from '../contracts/index.js';
import { runReview, resolveGitScope, getReposWithChanges } from '../core/index.js';
import * as path from 'node:path';
import { realpath } from 'node:fs/promises';

/**
 * Flags for review:run command
 */
type RunFlags = {
  mode?: ReviewMode;
  scope?: 'all' | 'changed' | 'staged';
  repos?: string[];
  task?: string;
  preset?: string;
  files?: string[];
  'eslint-config'?: string;
  cwd?: string;
  json?: boolean;
  agent?: boolean;
};

/**
 * Agent-friendly review report.
 * Simplified format for automated workflows.
 */
interface AgentReviewReport {
  /** Can the agent proceed (commit/merge)? */
  passed: boolean;
  /** Issues that must be fixed before proceeding */
  issues: Array<{
    file: string;
    line: number;
    problem: string;
    fix: string;
    severity: 'blocker' | 'high' | 'medium' | 'low' | 'info';
    /** Rule ID (e.g., "rule:security/no-eval" or "llm-lite:security") */
    ruleId: string;
    /** Source: "rule" (matched project rule) or "llm" (ad-hoc finding) */
    source: 'rule' | 'llm';
    /** Confidence score (0.0-1.0) from verification engine */
    confidence: number;
  }>;
  /** One-line summary for logs */
  summary: string;
}

/**
 * Severity order for sorting (lower = more critical)
 */
const SEVERITY_ORDER: Record<string, number> = {
  blocker: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

/**
 * Security-sensitive patterns for file filtering.
 * Shared across all file filtering operations for consistency.
 */
const SECURITY_IGNORE_PATTERNS = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/.git/**',
  '**/.kb/analytics/**',
  '**/.kb/cache/**',
  '**/.kb/storage/**',
  '**/.kb/database/**',
  '**/.env',
  '**/.env.*',
  '**/.ssh/**',
  '**/credentials/**',
  '**/password/**',
  '**/*.pem',
  '**/*.key',
  '**/*.secret',
] as const;

/**
 * Regex patterns for additional security filtering.
 * Used as a second layer of defense after glob ignore.
 */
const SECURITY_REGEX_PATTERNS = [
  /node_modules/,
  /\.git\//,
  /\.env$/,
  /\.env\./,
  /\.ssh/,
  /\/etc\//,
  /\/usr\//,
  /\/var\//,
  /credentials/i,
  /password/i,
  /\.pem$/,
  /\.key$/,
  /\.secret$/,
] as const;

/**
 * Validate that a file path is within the allowed directory.
 * Prevents path traversal attacks including symlink bypass.
 * Uses fs.realpath() to resolve symlinks and path.relative() for cross-platform safety.
 */
async function isPathWithinCwd(filePath: string, cwd: string): Promise<boolean> {
  try {
    const resolvedPath = path.resolve(cwd, filePath);
    const resolvedCwd = path.resolve(cwd);

    // Resolve symlinks to prevent symlink bypass attacks
    const realPath = await realpath(resolvedPath).catch(() => resolvedPath);
    const realCwd = await realpath(resolvedCwd).catch(() => resolvedCwd);

    const relative = path.relative(realCwd, realPath);
    // Path is within cwd if relative path exists, doesn't start with '..', and isn't absolute
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  } catch {
    // If path doesn't exist or can't be resolved, reject it
    return false;
  }
}

/**
 * Filter file paths for security concerns.
 */
async function filterSecurePaths(filePaths: string[], cwd: string): Promise<string[]> {
  const results = await Promise.all(
    filePaths.map(async filePath => {
      // Path traversal check (including symlink resolution)
      if (!await isPathWithinCwd(filePath, cwd)) {
        return null;
      }
      // Security pattern check
      if (SECURITY_REGEX_PATTERNS.some(pattern => pattern.test(filePath))) {
        return null;
      }
      return filePath;
    })
  );
  return results.filter((p): p is string => p !== null);
}

/**
 * Transform ReviewResult to agent-friendly format
 */
function toAgentReport(result: ReviewResult): AgentReviewReport {
  // Blocking issues = blocker and high severity only
  // Medium/low/info are acceptable and don't block the review
  const blockingIssues = result.findings.filter(
    f => f.severity === 'blocker' || f.severity === 'high'
  );

  // Pass when no blocking issues (medium and below are acceptable)
  const passed = blockingIssues.length === 0;

  // Sort by severity: blocker > high > medium > low > info
  const sortedFindings = [...result.findings].sort((a, b) => {
    const aOrder = SEVERITY_ORDER[a.severity] ?? 5;
    const bOrder = SEVERITY_ORDER[b.severity] ?? 5;
    return aOrder - bOrder;
  });

  const issues = sortedFindings.map(f => ({
    file: f.file,
    line: f.line,
    problem: f.message,
    fix: f.suggestion ?? 'Review and fix manually',
    severity: f.severity as 'blocker' | 'high' | 'medium' | 'low' | 'info',
    ruleId: f.ruleId ?? 'unknown',
    source: (f.ruleId?.startsWith('rule:') ? 'rule' : 'llm') as 'rule' | 'llm',
    // Map categorical confidence to numeric score (default 0.5 for undefined/unknown)
    confidence: f.confidence === 'certain' ? 1.0
      : f.confidence === 'likely' ? 0.8
      : f.confidence === 'heuristic' ? 0.6
      : 0.5,
  }));

  // Count non-blocking issues for summary
  const mediumCount = result.findings.filter(f => f.severity === 'medium').length;
  const lowCount = result.findings.filter(f => f.severity === 'low').length;
  const infoCount = result.findings.filter(f => f.severity === 'info').length;
  const nonBlockingCount = mediumCount + lowCount + infoCount;

  const summary = passed
    ? nonBlockingCount > 0
      ? `Review passed. ${nonBlockingCount} non-blocking issue(s) found (${mediumCount} medium, ${lowCount} low, ${infoCount} info).`
      : 'Review passed. No issues found.'
    : `Review failed. ${blockingIssues.length} blocking issue(s) must be fixed.`;

  return { passed, issues, summary };
}

export default defineCommand<unknown, CLIInput<RunFlags>, ReviewResult | AgentReviewReport>({
  id: 'review:run',
  description: 'Run code review analysis',

  handler: {
    // eslint-disable-next-line sonarjs/cognitive-complexity -- Main orchestration handler: coordinates input modes (repos/files/scope), git resolution, security filtering, output formats (agent/json/human), and severity-based exit codes
      async execute(ctx: PluginCommandContextV3, input: CLIInput<RunFlags>): Promise<CommandResult<ReviewResult | AgentReviewReport>> {
      const startTime = Date.now();

      // Extract flags from input
      const flags = input.flags;

      // Parse input
      const mode = flags.mode ?? 'heuristic';
      const scope = flags.scope ?? 'changed';

      // Use --cwd flag if provided, otherwise use current directory where command was run
      const cwd = flags.cwd ?? ctx.cwd ?? process.cwd();

      // Load config
      const fileConfig = await useConfig<{ eslintConfig?: string }>();

      // Show progress
      const loader = useLoader(`Running ${mode} analysis...`);
      loader.start();

      try {
        // Collect files based on scope
        let files: InputFile[] = [];
        let repoScope: string[] | undefined;

        // If --repos flag is provided, use git-scope resolver
        // Normalize repos to array (may come as string from CLI)
        const reposInput = flags.repos
          ? (Array.isArray(flags.repos) ? flags.repos : [flags.repos])
          : undefined;

        if (reposInput && reposInput.length > 0) {
          repoScope = reposInput;

          const scopedFiles = await resolveGitScope({
            cwd,
            repos: repoScope,
            includeStaged: scope === 'staged' || scope === 'changed',
            includeUnstaged: scope === 'changed',
            // Include untracked (new) files when explicitly scoping to repos
            includeUntracked: true,
          });

          files = scopedFiles.files;
        } else if (flags.files) {
          // Expand glob patterns first, then read files
          const filePatterns = Array.isArray(flags.files) ? flags.files : [flags.files];
          const expanded: string[] = [];
          for (const pattern of filePatterns) {
            const matches = await ctx.runtime.fs.glob(pattern, {
              cwd,
              ignore: [...SECURITY_IGNORE_PATTERNS],
            });
            expanded.push(...matches);
          }
          const safeFilePaths = await filterSecurePaths(expanded, cwd);

          const fileReadResults = await Promise.allSettled(
            safeFilePaths.map(async (filePath) => ({
              path: filePath,
              content: await ctx.runtime.fs.readFile(filePath, 'utf-8'),
            }))
          );

          files = fileReadResults
            .filter((r): r is PromiseFulfilledResult<InputFile> => r.status === 'fulfilled')
            .map(r => r.value);
        } else {
          // Resolve files based on file scope (all/changed/staged)
          let filePaths: string[] = [];

          switch (scope) {
            case 'all':
              filePaths = await ctx.runtime.fs.glob('**/*', { cwd, ignore: [...SECURITY_IGNORE_PATTERNS] });
              break;

            case 'staged':
              const reposWithChanges = await getReposWithChanges(cwd);
              if (reposWithChanges.length > 0) {
                const scopedFiles = await resolveGitScope({
                  cwd,
                  repos: reposWithChanges,
                  includeStaged: true,
                  includeUnstaged: false,
                  includeUntracked: false,
                });
                files = scopedFiles.files;
                repoScope = reposWithChanges;
              }
              break;

            case 'changed':
            default:
              const changedRepos = await getReposWithChanges(cwd);
              if (changedRepos.length > 0) {
                const scopedFiles = await resolveGitScope({
                  cwd,
                  repos: changedRepos,
                  includeStaged: true,
                  includeUnstaged: true,
                  includeUntracked: true,
                });
                files = scopedFiles.files;
                repoScope = changedRepos;
              }
              break;
          }

          // If we used glob fallback, read file contents
          if (files.length === 0 && filePaths.length > 0) {
            // Apply security filtering (path traversal + pattern matching)
            const safeFilePaths = await filterSecurePaths(filePaths, cwd);

            // Read files with individual error handling
            const fileReadResults = await Promise.allSettled(
              safeFilePaths.map(async (filePath) => ({
                path: filePath,
                content: await ctx.runtime.fs.readFile(filePath, 'utf-8'),
              }))
            );

            // Collect successful reads, skip failed ones
            files = fileReadResults
              .filter((r): r is PromiseFulfilledResult<InputFile> => r.status === 'fulfilled')
              .map(r => r.value);
          }
        }

        // No files found — give a clear, actionable message instead of a cryptic engine error
        if (files.length === 0) {
          loader.fail('No files to review');
          const hint = scope === 'staged'
            ? 'No staged files found. Stage files with `git add` first, or use `--scope=changed`.'
            : 'No changed files found. Use `--scope=all` to review all files, or `--files` to specify files explicitly.';
          return validationError(hint);
        }

        // Run review
        const result = await runReview({
          files,
          mode,
          presetId: flags.preset ?? 'default',
          cwd,
          taskContext: flags.task,
          repoScope,
          config: {
            eslintConfig: flags['eslint-config'] ?? fileConfig?.eslintConfig,
          },
        });

        loader.succeed(`Found ${result.findings.length} issue(s)`);

        // Output results
        if (!flags.json) {
          // Build sections
          const sections: Array<{ header?: string; items: string[] }> = [];

          // Summary section
          const counts = {
            blocker: result.findings.filter((f) => f.severity === 'blocker').length,
            high: result.findings.filter((f) => f.severity === 'high').length,
            medium: result.findings.filter((f) => f.severity === 'medium').length,
            low: result.findings.filter((f) => f.severity === 'low').length,
            info: result.findings.filter((f) => f.severity === 'info').length,
          };

          const summaryItems: string[] = [
            `Files: ${result.metadata.analyzedFiles}`,
            `Findings: ${result.findings.length}`,
          ];

          // Show task context if provided
          if (flags.task) {
            summaryItems.push(`Task: ${flags.task}`);
          }

          // Show repo scope if used
          if (repoScope && repoScope.length > 0) {
            summaryItems.push(`Repos: ${repoScope.join(', ')}`);
          }

          if (counts.blocker > 0) {
            summaryItems.push(`Blocker: ${counts.blocker}`);
          }
          if (counts.high > 0) {
            summaryItems.push(`High: ${counts.high}`);
          }
          if (counts.medium > 0) {
            summaryItems.push(`Medium: ${counts.medium}`);
          }
          if (counts.low > 0) {
            summaryItems.push(`Low: ${counts.low}`);
          }
          if (counts.info > 0) {
            summaryItems.push(`Info: ${counts.info}`);
          }

          summaryItems.push(`Engines: ${result.metadata.engines.join(', ')}`);



          // Show incremental stats if available (LLM modes with caching)
          const incr = result.metadata.incremental;
          if (incr) {
            if (incr.cachedFiles > 0) {
              summaryItems.push(`Cached: ${incr.cachedFiles} file(s) skipped`);
            }
            if (incr.newFindings > 0 || incr.knownFindings > 0 || incr.cachedFindings > 0) {
              const parts: string[] = [];
              if (incr.newFindings > 0) {
                parts.push(`${incr.newFindings} new`);
              }
              if (incr.knownFindings > 0) {
                parts.push(`${incr.knownFindings} known`);
              }
              if (incr.cachedFindings > 0) {
                parts.push(`${incr.cachedFindings} cached`);
              }
              summaryItems.push(`Breakdown: ${parts.join(', ')}`);
            }
          }

          sections.push({
            header: 'Summary',
            items: summaryItems,
          });

          // Findings section (top 10, sorted by severity)
          if (result.findings.length > 0) {
            // Sort by severity: blocker > high > medium > low > info
            const sortedFindings = [...result.findings].sort((a, b) => {
              const aOrder = SEVERITY_ORDER[a.severity] ?? 5;
              const bOrder = SEVERITY_ORDER[b.severity] ?? 5;
              return aOrder - bOrder;
            });

            const topFindings = sortedFindings.slice(0, 10);
            const findingsItems = topFindings.map((f) => {
              const loc = `${f.file}:${f.line}`;
              const severity = f.severity.toUpperCase();
              return `[${severity}] ${loc} - ${f.message}`;
            });

            if (result.findings.length > 10) {
              findingsItems.push(`... and ${result.findings.length - 10} more`);
            }

            sections.push({
              header: 'Findings',
              items: findingsItems,
            });
          }

          const timing = Date.now() - startTime;

          if (result.findings.length === 0) {
            ctx.ui?.success?.('No issues found', {
              title: 'Code Review',
              sections,
              timing,
            });
          } else {
            ctx.ui?.warn?.(`Found ${result.findings.length} issue(s)`, {
              title: 'Code Review',
              sections,
              timing,
            });
          }
        }

        // Exit code based on severity
        const blockerCount = result.findings.filter((f) => f.severity === 'blocker').length;
        const highCount = result.findings.filter((f) => f.severity === 'high').length;
        const agentReport = toAgentReport(result);

        if (blockerCount > 0) {
          return {
            ok: false,
            error: {
              code: 'KB_RUNTIME_COMMAND_FAILED',
              message: 'Command failed',
              hint: "Run `kb review run --help` to review its inputs and recovery steps, then retry.",
              diagnostics: agentReport.issues.map((issue) => ({
                code: 'KB_REVIEW_FINDING',
                severity: issue.severity === 'blocker' || issue.severity === 'high' ? 'error' as const : 'warning' as const,
                path: issue.file,
                line: issue.line,
                message: issue.problem,
                hint: issue.fix,
              })),
            },
          };
        }

        if (mode === 'heuristic' && highCount > 0) {
          // In CI mode (heuristic), fail on high severity
          return {
            ok: false,
            error: {
              code: 'KB_RUNTIME_COMMAND_FAILED',
              message: 'Command failed',
              hint: "Run `kb review run --help` to review its inputs and recovery steps, then retry.",
              diagnostics: agentReport.issues.map((issue) => ({
                code: 'KB_REVIEW_FINDING',
                severity: issue.severity === 'blocker' || issue.severity === 'high' ? 'error' as const : 'warning' as const,
                path: issue.file,
                line: issue.line,
                message: issue.problem,
                hint: issue.fix,
              })),
            },
          };
        }

        return agentReport;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        loader.fail(`Review failed: ${message}`);
        return handleError(error);
      }
    },
  },
});
