/**
 * High-performance commit parser with conventional commits support
 * Single git log traversal with streaming parse
 */

import simpleGit from 'simple-git';
import type { Change, CommitType, BreakingChange, Reference, Author, ParseOptions } from './types';

/**
 * Parse commits from git history using single traversal
 * Performance: O(commits) - no N× git diff calls
 */
export async function parseCommits(options: ParseOptions): Promise<Change[]> {
  const {
    cwd,
    from,
    to = 'HEAD',
    packagePath,
    ignoreAuthors = [],
    includeTypes,
    excludeTypes,
    collapseMerges = true,
    collapseReverts = true,
    preferMergeSummary = true,
  } = options;

  const git = simpleGit(cwd);

  // Build git log command for single traversal
  // Format: SHA, author name, author email, author date (ISO), subject, body
  const format = '%H%x00%an%x00%ae%x00%ai%x00%s%x00%b%n--COMMIT_FOOTER--';

  // Get commits with --name-status for changed files info
  // NOTE: simple-git requires arguments as separate array elements for git.raw()
  // Special case: if from ends with ^, it might not exist (parent of first commit)
  // In this case, use --root to show all commits from beginning
  const useRoot = from.endsWith('^');
  const logArgs = useRoot
    ? ['log', '--no-merges', '--name-status', '--root', `--format=${format}`, to]
    : ['log', '--no-merges', '--name-status', `--format=${format}`, `${from}..${to}`];

  // Add package filter if specified
  if (packagePath) {
    logArgs.push('--', packagePath);
  }

  const logOutput = await git.raw(logArgs);

  return parseGitLogOutput(logOutput, {
    ignoreAuthors,
    includeTypes,
    excludeTypes,
    collapseMerges,
    collapseReverts,
    preferMergeSummary,
  });
}

/**
 * Parse raw git log output into Change objects
 */
function parseGitLogOutput(
  output: string,
  options: {
    ignoreAuthors: string[];
    includeTypes?: string[];
    excludeTypes?: string[];
    collapseMerges: boolean;
    collapseReverts: boolean;
    preferMergeSummary: boolean;
  }
): Change[] {
  const changes: Change[] = [];

  // Split by commit delimiter
  // Each commit block contains: header line + optional file changes
  // After --COMMIT_FOOTER-- there's a blank line, then file lines (D/M/A), then blank line before next commit
  const commits = output.split('--COMMIT_FOOTER--').filter(Boolean);

  for (let i = 0; i < commits.length; i++) {
    const commitBlock = commits[i];
    if (!commitBlock) {continue;}

    // After split by --COMMIT_FOOTER--, format is:
    // Block 0: "SHA\0author...\0body\n"
    // Block 1: "\n\nD\tfile1\nM\tfile2\nSHA\0author...\0body\n"
    // Block 2: "\n\nA\tfile3\nSHA\0...\n"
    //
    // So: header is at END of block, files are at BEGINNING of NEXT block

    const lines = commitBlock.split('\n');

    // Find header line (contains \0 separators) - should be first non-empty line
    let header = '';
    for (const line of lines) {
      if (line.trim() && line.includes('\0')) {
        header = line;
        break;
      }
    }

    if (!header) {
      continue;
    }

    // File lines come from NEXT block (before next commit's header)
    const fileLines: string[] = [];
    if (i + 1 < commits.length) {
      const nextBlock = commits[i + 1];
      if (!nextBlock) {continue;}

      const nextLines = nextBlock.split('\n');

      // Take lines until we hit next header (line with \0)
      for (const line of nextLines) {
        if (line.trim() && line.includes('\0')) {
          break; // This is next commit's header
        }
        if (line.trim()) {
          fileLines.push(line);
        }
      }
    }

    // Parse header: SHA\0author\0email\0date\0subject\0body
    const [sha, authorName, authorEmail, authorDate, subject, body = ''] = header.split('\0');

    if (!sha || sha.length !== 40 || !authorName || !authorEmail || !authorDate || !subject) {
      continue; // Invalid fields
    }

    // Ignore bot authors
    if (options.ignoreAuthors.some((pattern: string) => matchesGlob(authorName, pattern))) {
      continue;
    }

    // Parse conventional commit
    const convention = parseConventionalCommit(`${subject}\n\n${body || ''}`);

    // Skip filtered types
    if (shouldSkipCommit(convention.type, options.includeTypes, options.excludeTypes)) {
      continue;
    }

    // Extract files from --name-status output
    const filesChanged = parseFileChanges(fileLines);

    // Map files to packages (basic implementation, will be enhanced)
    const packages = extractPackagesFromFiles(filesChanged);

    // Build Change object
    const change: Change = {
      sha,
      type: convention.type,
      scope: convention.scope,
      subject: convention.subject,
      body: convention.body,
      breaking: convention.breaking,
      refs: extractReferences(convention.footers),
      author: {
        name: authorName,
        email: authorEmail,
      },
      coAuthors: extractCoAuthors(convention.footers),
      packages,
      filesChanged: filesChanged.map(f => f.path),
      timestamp: authorDate,
      isMerge: false,
      isRevert: convention.type === 'revert',
      revertOf: extractRevertOf(convention.body, convention.footers),
      cherryPickOf: extractCherryPickOf(convention.footers),
    };

    changes.push(change);
  }

  return changes;
}

/**
 * Parse conventional commit format
 */
function parseConventionalCommit(commitMessage: string): {
  type: CommitType;
  scope?: string;
  subject: string;
  body?: string;
  breaking?: BreakingChange[];
  footers: string[];
} {
  const lines = commitMessage.split('\n');
  const header = lines[0] || '';
  const bodyLines = lines.slice(2); // Skip empty line after header
  const body = bodyLines.join('\n').trim();

  // Parse header with conventional commits format: type(scope): subject or type(scope)!: subject
  const headerMatch = header.match(/^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/);

  let parsedType: string | undefined;
  let parsedScope: string | undefined;
  let parsedSubject: string = '';
  let hasBreaking = false;

  if (headerMatch) {
    parsedType = headerMatch[1];
    parsedScope = headerMatch[2];
    hasBreaking = headerMatch[3] === '!';
    parsedSubject = headerMatch[4] || '';
  } else {
    // Fallback: treat whole header as subject
    parsedType = undefined;
    parsedSubject = header;
  }

  const type = normalizeType(parsedType);
  const breaking: BreakingChange[] = [];

  // Detect breaking changes from ! suffix in header
  if (hasBreaking) {
    breaking.push({ summary: parsedSubject });
  }

  // Extract footers (lines starting with keyword followed by :)
  const footers: string[] = [];
  const footerLines = body.split('\n');
  for (const line of footerLines) {
    if (/^[A-Z-]+:\s*/.test(line)) {
      footers.push(line);
      // Check for BREAKING CHANGE footer
      const breakingMatch = line.match(/^BREAKING CHANGE:\s*(.+)/);
      if (breakingMatch && breakingMatch[1]) {
        breaking.push({ summary: breakingMatch[1] });
      }
    }
  }

  return {
    type,
    scope: parsedScope,
    subject: parsedSubject,
    body: body || undefined,
    breaking: breaking.length > 0 ? breaking : undefined,
    footers,
  };
}

/**
 * Normalize commit type
 */
function normalizeType(type: string | undefined): CommitType {
  const normalized = (type || 'chore').toLowerCase();
  const validTypes: CommitType[] = ['feat', 'fix', 'perf', 'refactor', 'docs', 'build', 'ci', 'test', 'chore', 'revert', 'style'];
  return validTypes.includes(normalized as CommitType) ? (normalized as CommitType) : 'chore';
}

/**
 * Parse --name-status output into file changes
 */
interface FileChange {
  path: string;
  status: string;
  oldPath?: string;
}

function parseFileChanges(lines: string[]): FileChange[] {
  const changes: FileChange[] = [];
  
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('diff --git')) {continue;}
    
    // Parse status + file: "A\tpath/to/file" or "R100\told\to/new"
    const match = line.match(/^([ADMRT])\t(.*?)$/);
    if (!match) {continue;}

    const [, status, path] = match;
    if (!path || !status) {continue;}
    
    if (status === 'R' || status === 'C') {
      // Rename/Copy: path contains old\tnew
      const [oldPath, newPath] = path.split('\t');
      if (newPath) {
        changes.push({ path: newPath, status, oldPath });
      }
      if (oldPath) {
        changes.push({ path: oldPath, status: 'D' });
      }
    } else {
      changes.push({ path, status });
    }
  }

  return changes;
}

/**
 * Extract package names from file paths
 * Basic implementation - will be enhanced with devlink graph
 */
function extractPackagesFromFiles(files: FileChange[]): string[] {
  const packages = new Set<string>();
  
  for (const file of files) {
    // Match patterns like: packages/pkg-name/...
    const match = file.path.match(/^packages\/([^/]+)/);
    if (match) {
      packages.add(`packages/${match[1]}`);
    }
  }

  return Array.from(packages);
}

/**
 * Extract references from footers (Closes #123, etc.)
 */
function extractReferences(footers: string[]): Reference[] {
  const refs: Reference[] = [];

  for (const footer of footers) {
    // Match: Closes #123, Fixes #456, Refs #789
    const match = footer.match(/(?:Closes|Fixes|Refs)\s+#(\d+)/i);
    if (match && match[1]) {
      refs.push({
        type: footer.toLowerCase().includes('closes') || footer.toLowerCase().includes('fixes') ? 'issue' : 'pr',
        id: match[1],
      });
    }
  }

  return refs;
}

/**
 * Extract co-authors from footers
 */
function extractCoAuthors(footers: string[]): Author[] {
  const coAuthors: Author[] = [];

  for (const footer of footers) {
    const match = footer.match(/^Co-authored-by:\s*(.+?)\s*<(.+?)>$/i);
    if (match && match[1] && match[2]) {
      coAuthors.push({
        name: match[1].trim(),
        email: match[2].trim(),
      });
    }
  }

  return coAuthors;
}

/**
 * Extract revert target SHA
 */
function extractRevertOf(body: string | undefined, footers: string[]): string | undefined {
  if (!body) {return undefined;}

  const match = body.match(/revert (?:of\s+)?([0-9a-f]{40})/i);
  return match ? match[1] : undefined;
}

/**
 * Extract cherry-pick source SHA
 */
function extractCherryPickOf(footers: string[]): string | undefined {
  for (const footer of footers) {
    const match = footer.match(/cherry picked from (.+)/i);
    if (match && match[1]) {return match[1].trim();}
  }
  return undefined;
}

/**
 * Check if commit should be skipped based on type filters
 */
function shouldSkipCommit(
  type: string,
  includeTypes?: string[],
  excludeTypes?: string[]
): boolean {
  if (includeTypes && !includeTypes.includes(type)) {
    return true;
  }
  if (excludeTypes && excludeTypes.includes(type)) {
    return true;
  }
  return false;
}

/**
 * Match glob pattern (simplified implementation)
 */
function matchesGlob(text: string, pattern: string): boolean {
  // Handle wildcards: *[bot] matches any[bot], renovate* matches renovate-*
  const regexPattern = pattern
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  
  const regex = new RegExp(`^${regexPattern}$`, 'i');
  return regex.test(text);
}

